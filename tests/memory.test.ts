import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  JsonFileStore,
  InMemoryStore,
  MemoryDatabase,
  MemoryExtractor,
  MemoryManager,
  HashedEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  classifyOutcome,
  commandMatchesAction,
  computeSuccessScore,
  consolidateDatabase,
  cosineSimilarity,
  createEnvironment,
  createMemoryEntry,
  embedText,
  environmentMatch,
  evaluatePostcondition,
  extractErrorSignature,
  mergeIntoDatabase,
  redactSecrets,
  retrieveMemories,
  scoreMemory,
} from "../src/memory";
import {
  canAutoApprove,
  detectDangerousCommand,
  requiresExplicitConfirmation,
} from "../src/lib/command_risk";
import { injectMemoryIntoMessages } from "../src/lib/request_messages";

async function main(): Promise<void> {
  // ------------------------------------------------------------ embeddings
  const pipProblem = embedText(
    "pip install requests failed command not found in powershell",
  );
  const pipProblemSimilar = embedText(
    "pip install package command not found in powershell terminal",
  );
  const dockerTopic = embedText(
    "docker compose up postgres database container networking volumes",
  );
  assert.ok(
    cosineSimilarity(pipProblem, pipProblemSimilar) >
      cosineSimilarity(pipProblem, dockerTopic),
    "similar commands should have higher cosine similarity",
  );

  // ------------------------------------------------------ error signatures
  assert.equal(
    extractErrorSignature("'pip' is not recognized as an internal or external command"),
    "command_not_found",
  );
  assert.equal(
    extractErrorSignature("cannot be loaded because running scripts is disabled on this system"),
    "powershell_execution_policy",
  );
  assert.equal(
    extractErrorSignature("ModuleNotFoundError: No module named 'requests'"),
    "module_not_found",
  );
  assert.equal(classifyOutcome("Execution of scripts is disabled on this system"), "failure");
  assert.equal(classifyOutcome("Successfully installed requests-2.31.0"), "success");
  assert.equal(classifyOutcome(""), "unknown");

  // --------------------------------------------------------------- scoring
  assert.equal(
    computeSuccessScore({
      exitCodeZero: true,
      expectedOutputMatched: true,
      validated: true,
      goalCompleted: true,
      userConfirmed: false,
    }),
    0.9,
  );
  assert.equal(computeSuccessScore({ exitCodeZero: true, goalCompleted: false }), 0.25);

  // ----------------------------------------------------------- environment
  const win = createEnvironment({
    os: "windows",
    shell: "powershell",
    runtime: "python",
    tools: ["pip", "git"],
  });
  const winCopy = createEnvironment({
    os: "windows",
    shell: "powershell",
    runtime: "python",
    tools: ["pip", "git"],
  });
  const linux = createEnvironment({
    os: "linux",
    shell: "bash",
    runtime: "node",
    tools: ["npm"],
  });
  assert.ok(environmentMatch(win, winCopy) > 0.99, "identical environments must match");
  assert.ok(environmentMatch(win, linux) < 0.5, "different environments must not match");

  // ------------------------------------------------------ action matching
  assert.equal(commandMatchesAction("npm install left-pad", "npm install"), true);
  assert.equal(
    commandMatchesAction("py -m pip install urllib3", "py -m pip install requests"),
    true,
  );
  assert.equal(commandMatchesAction("npm publish", "npm install"), false);

  // -------------------------------------------------- end-to-end learning
  async function learnFromFailureThenFix(): Promise<MemoryManager> {
    const manager = new MemoryManager({
      store: new InMemoryStore(),
      consolidationIntervalMs: 0,
      retrievalLimit: 6,
    });
    manager.setEnvironment(
      createEnvironment({ os: "windows", shell: "powershell", runtime: "python" }),
    );
    await manager.observeUserMessage("Установи пакет requests");

    await manager.observeToolResult({
      toolName: "run_shell_command",
      args: { command: "pip install requests" },
      output: "'pip' is not recognized as an internal or external command",
      ok: true,
    });
    await manager.observeToolResult({
      toolName: "run_shell_command",
      args: { command: "py -m pip install requests" },
      output: "Successfully installed requests-2.31.0",
      ok: true,
    });
    await manager.consolidate();
    return manager;
  }

  const learned = await learnFromFailureThenFix();
  const learnedStats = learned.getStats();
  assert.ok(learnedStats.byType.episode >= 1, "an episode should be recorded");
  assert.ok(learnedStats.byType.procedure >= 1, "a procedure should be recorded");
  assert.ok(learnedStats.byType.avoid >= 1, "an avoid rule should be recorded");
  assert.ok(learnedStats.byType.lesson >= 1, "a lesson should be recorded");

  const context = await learned.buildContext("установить пакет urllib3");
  assert.ok(context, "memory context should be produced");
  assert.match(context ?? "", /py -m pip install/, "remembered solution must appear in context");

  // An unrelated environment must not surface the Windows fix.
  const otherEnvManager = new MemoryManager({ store: new InMemoryStore() });
  otherEnvManager.setEnvironment(createEnvironment({ os: "linux", shell: "bash" }));
  await otherEnvManager.observeUserMessage("install python package");
  const emptyContext = await otherEnvManager.buildContext("install python package");
  assert.ok(
    !emptyContext || !emptyContext.includes("py -m pip install"),
    "memory from a different environment must not leak in",
  );

  // ------------------------------------------------------- consolidation
  const db = new MemoryDatabase({ store: new InMemoryStore() });
  const base = createMemoryEntry({
    type: "procedure",
    text: "pip fails in powershell",
    solution: "py -m pip install x",
    action: "py -m pip install x",
    environment: win,
    successCount: 1,
  });
  db.upsertMany([
    { ...base, id: "dup-a" },
    { ...base, id: "dup-b" },
  ]);
  const consolidation = consolidateDatabase(db, { now: Date.now() });
  assert.equal(consolidation.merged, 1, "duplicate procedures must be merged");
  assert.equal(db.size(), 1, "only one procedure should remain");

  // --------------------------------------------------- secret redaction
  // All sample credentials below are assembled from parts on purpose: a
  // token-shaped literal in the source would (correctly) trip the GitHub push
  // protection scanner, even though the value is fake.
  const fakeOpenAiKey = ["sk", "abcdef1234567890ABCDEF"].join("-");
  assert.equal(
    redactSecrets(`Authorization: Bearer ${fakeOpenAiKey}`),
    "Authorization: Bearer ***",
  );
  assert.equal(
    redactSecrets(`OPENAI_API_KEY=${fakeOpenAiKey}`).includes("abcdef1234567890"),
    false,
    "api keys must be redacted before storage",
  );
  const secretEntry = createMemoryEntry({
    type: "episode",
    text: `curl -H 'Authorization: Bearer ${["super", "secret", "token12345"].join("")}' https://api.example.com`,
    environment: win,
  });
  assert.equal(/supersecrettoken/.test(secretEntry.text), false, "entry text must be redacted");

  // --------------------------------------------------- postconditions
  assert.equal(evaluatePostcondition("npm install", "added 128 packages in 4s").matched, true);
  assert.equal(evaluatePostcondition("npm install", "npm ERR! code ERESOLVE").matched, false);
  assert.equal(evaluatePostcondition("pip install requests", "Successfully installed requests").matched, true);
  assert.equal(evaluatePostcondition("echo hi", "hi").matched, null);

  // ------------------------------------------------ procedure lifecycle
  const ldb = new MemoryDatabase({ store: new InMemoryStore() });
  const draftData = {
    errorSignature: "command_not_found",
    problemSignature: "pip|command_not_found",
  };
  const candidate = createMemoryEntry({
    type: "procedure",
    text: "pip fails",
    solution: "py -m pip install x",
    action: "py -m pip install x",
    environment: win,
    successCount: 1,
    sessionIds: ["s1"],
    data: { ...draftData },
  });
  assert.equal(candidate.status, "candidate", "one success must stay a candidate");
  ldb.upsert(candidate);

  mergeIntoDatabase(
    ldb,
    createMemoryEntry({
      type: "procedure",
      text: "pip fails",
      solution: "py -m pip install x",
      action: "py -m pip install x",
      environment: win,
      successCount: 1,
      sessionIds: ["s2"],
      data: { ...draftData },
    }),
  );
  assert.equal(ldb.byType("procedure")[0].status, "validated", "two independent sessions validate");

  mergeIntoDatabase(
    ldb,
    createMemoryEntry({
      type: "procedure",
      text: "pip fails",
      solution: "py -m pip install x",
      action: "py -m pip install x",
      environment: win,
      successCount: 1,
      sessionIds: ["s3"],
      data: { ...draftData },
    }),
  );
  assert.equal(ldb.byType("procedure")[0].status, "trusted", "three sessions make it trusted");

  // ------------------------------------------------------- supersession
  const sdb = new MemoryDatabase({ store: new InMemoryStore() });
  const weak = createMemoryEntry({
    type: "procedure",
    text: "pnpm blocked by execution policy",
    solution: "pnpm install",
    action: "pnpm install",
    environment: win,
    successCount: 1,
    failureCount: 1,
    sessionIds: ["a"],
    data: { errorSignature: "powershell_execution_policy", problemSignature: "pnpm|powershell_execution_policy" },
  });
  const strong = createMemoryEntry({
    type: "procedure",
    text: "pnpm blocked by execution policy",
    solution: "pnpm.cmd install",
    action: "pnpm.cmd install",
    environment: win,
    successCount: 5,
    failureCount: 0,
    sessionIds: ["a", "b", "c"],
    data: { errorSignature: "powershell_execution_policy", problemSignature: "pnpm|powershell_execution_policy" },
  });
  sdb.upsertMany([weak, strong]);
  const supersession = consolidateDatabase(sdb, { now: Date.now() });
  assert.ok(supersession.superseded >= 1, "a weaker solution must be superseded");
  assert.equal(sdb.get(weak.id)?.status, "superseded");
  assert.equal(sdb.get(weak.id)?.supersededBy, strong.id);

  const superQuery = {
    text: "pnpm.execution policy blocked",
    embedding: embedText("pnpm execution policy blocked"),
    environment: win,
    now: Date.now(),
    limit: 5,
    tool: "pnpm",
    errorSignature: "powershell_execution_policy",
  };
  const superResults = retrieveMemories(sdb.all(), superQuery);
  assert.ok(
    superResults.every((item) => item.entry.id !== weak.id),
    "superseded memories must not be retrieved",
  );

  // ------------------------------------------------- contextual avoid
  const adb = new MemoryDatabase({ store: new InMemoryStore() });
  const avoidRule = createMemoryEntry({
    type: "avoid",
    text: "pip not found in PowerShell",
    environment: win,
    failureCount: 2,
    successCount: 0,
    data: {
      errorSignature: "command_not_found",
      problemSignature: "pip|command_not_found",
      avoid: ["pip install requests"],
    },
  });
  adb.upsert(avoidRule);
  const linuxAvoidQuery = {
    text: "pip install requests",
    embedding: embedText("pip install requests"),
    environment: linux,
    now: Date.now(),
    limit: 5,
    errorSignature: "command_not_found",
  };
  assert.equal(
    retrieveMemories(adb.all(), linuxAvoidQuery).length,
    0,
    "avoid rules must not leak into another environment",
  );
  const winAvoidQuery = { ...linuxAvoidQuery, environment: win };
  assert.ok(retrieveMemories(adb.all(), winAvoidQuery).length >= 1, "avoid rule applies in its own environment");

  // ------------------------------------------------ exact signal boost
  const signalQuery = {
    text: "command not found",
    embedding: embedText("command not found"),
    environment: win,
    now: Date.now(),
    limit: 5,
    errorSignature: "command_not_found",
  };
  const withSignal = createMemoryEntry({
    type: "procedure",
    text: "pip fails",
    solution: "py -m pip install x",
    action: "a1",
    environment: win,
    successCount: 2,
    data: { errorSignature: "command_not_found" },
  });
  const otherSignal = createMemoryEntry({
    type: "procedure",
    text: "pip fails",
    solution: "py -m pip install x",
    action: "a2",
    environment: win,
    successCount: 2,
    data: { errorSignature: "network" },
  });
  assert.ok(
    scoreMemory(withSignal, signalQuery).score > scoreMemory(otherSignal, signalQuery).score,
    "an exact error-signature match must rank higher",
  );

  // ------------------------------------------------- embedding providers
  const hashed = new HashedEmbeddingProvider();
  assert.equal(hashed.id(), "hashed-v1");
  assert.equal((await hashed.embed("hello world")).length, hashed.dimensions());

  let capturedBody: any = null;
  const openai = new OpenAICompatibleEmbeddingProvider({
    endpoint: "http://127.0.0.1:1234/",
    model: "bge-m3",
    dimensions: 0,
    fetchImpl: (async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: [3, 4] }] }),
      } as any;
    }) as any,
  });
  const vector = await openai.embed("hello");
  assert.deepEqual(vector, [0.6, 0.8], "provider vectors must be L2-normalized");
  assert.equal(openai.dimensions(), 2, "dimensions auto-detected from the response");
  assert.equal(capturedBody.model, "bge-m3");
  // id остаётся стабильным и не зависит от автодетекта размерности: иначе после
  // первого ответа сервера он менялся, все записи считались устаревшими и полный
  // ре-индекс запускался при каждом старте Tabby.
  assert.equal(openai.id(), "openai:bge-m3:auto");

  // ------------------------------------------------- approval policy
  assert.equal(canAutoApprove("npm run build", "medium", "medium"), true);
  assert.equal(canAutoApprove("npm run build", "high", "medium"), false);
  assert.equal(canAutoApprove("ls", "low", "none"), false);
  assert.equal(
    canAutoApprove("rm -rf /", "low", "critical"),
    false,
    "dangerous commands are never auto-approved",
  );
  assert.equal(requiresExplicitConfirmation("shutdown /s /t 0"), true);
  assert.equal(detectDangerousCommand("reg delete HKLM\\Software /f").dangerous, true);
  assert.equal(detectDangerousCommand("npm run format").dangerous, false);

  // --------------------------- memory injection stays template-safe
  const baseMessages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];
  const injected = injectMemoryIntoMessages(baseMessages, "## Память агента");
  assert.equal(injected.length, 2, "memory must not add a separate system message");
  assert.equal(
    injected.filter((message) => message.role === "system").length,
    1,
    "there must be exactly one system message",
  );
  assert.match(String(injected[1].content), /Память агента/);
  assert.deepEqual(
    injectMemoryIntoMessages(baseMessages, null),
    baseMessages,
    "no memory context means no change",
  );
  const imageMessages: any[] = [
    { role: "system", content: "sys" },
    {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "x" } },
      ],
    },
  ];
  const injectedImage = injectMemoryIntoMessages(imageMessages, "MEM");
  const imageContent = injectedImage[1].content as any[];
  assert.ok(Array.isArray(imageContent));
  assert.equal(imageContent[imageContent.length - 1].text, "MEM");

  // ------------------------------------------------------ task outcomes
  const tm = new MemoryManager({ store: new InMemoryStore(), consolidationIntervalMs: 1_000_000 });
  tm.setEnvironment(win);
  await tm.observeUserMessage("deploy the service");
  await tm.observeToolResult({
    toolName: "run_shell_command",
    args: { command: "npm run build" },
    output: "compiled successfully",
    ok: true,
  });
  await tm.finishTurn();
  const outcomes = tm.getTaskOutcomes();
  assert.equal(outcomes.length, 1, "a task outcome must be recorded");
  assert.equal(outcomes[0].completed, true);
  assert.equal(outcomes[0].firstAttemptSuccess, true);
  const metrics = tm.getMetrics();
  assert.equal(metrics.tasks, 1);
  assert.equal(metrics.completed, 1);
  assert.equal(metrics.firstAttemptSuccessRate, 1);

  const tmFail = new MemoryManager({ store: new InMemoryStore(), consolidationIntervalMs: 1_000_000 });
  tmFail.setEnvironment(win);
  await tmFail.observeUserMessage("start the project");
  await tmFail.observeToolResult({
    toolName: "run_shell_command",
    args: { command: "npm start" },
    output: "Error: Cannot find module 'express'",
    ok: true,
  });
  await tmFail.finishTurn();
  const failedOutcome = tmFail.getTaskOutcomes()[0];
  assert.equal(failedOutcome.completed, false, "a failing command must fail the task");
  assert.equal(failedOutcome.firstAttemptSuccess, false);
  assert.equal(tmFail.getMetrics().completedRate, 0);

  // ------------------------------------------------- contradiction sets
  const cdb = new MemoryDatabase({ store: new InMemoryStore() });
  const variantA = createMemoryEntry({
    type: "procedure",
    text: "pnpm install blocked by policy",
    solution: "pnpm.cmd install",
    action: "pnpm.cmd install",
    environment: win,
    successCount: 3,
    failureCount: 1,
    sessionIds: ["a", "b", "c"],
    data: { errorSignature: "powershell_execution_policy", problemSignature: "pnpm|powershell_execution_policy" },
  });
  const variantB = createMemoryEntry({
    type: "procedure",
    text: "pnpm install blocked by policy",
    solution: "pnpm install",
    action: "pnpm install",
    environment: win,
    successCount: 3,
    failureCount: 1,
    sessionIds: ["a", "b", "c"],
    data: { errorSignature: "powershell_execution_policy", problemSignature: "pnpm|powershell_execution_policy" },
  });
  cdb.upsertMany([variantA, variantB]);
  consolidateDatabase(cdb, { now: Date.now() });
  const conflicted = cdb.all().filter((entry) => entry.conflictSetId);
  assert.equal(conflicted.length, 2, "competing solutions must share a conflict set");
  assert.equal(
    new Set(conflicted.map((entry) => entry.conflictSetId)).size,
    1,
    "both variants must reference the same conflict set",
  );

  // ---------------------------------------------------------- persistence
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-memory-"));
  try {
    const memoryFile = path.join(tempDir, "memory.json");
    const seedEntries = learned.listMemories();
    await new JsonFileStore(memoryFile).save(seedEntries);

    const reloaded = new MemoryManager({ store: new JsonFileStore(memoryFile) });
    await reloaded.initialize();
    assert.equal(reloaded.getStats().total, seedEntries.length, "memory must survive a reload");
    assert.ok(
      (await reloaded.buildContext("установить urllib3"))?.includes("py -m pip install"),
      "reloaded memory must still be retrievable",
    );
    await reloaded.flush();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.deepEqual(
    await new JsonFileStore(path.join(os.tmpdir(), "tabby-memory-missing.json")).load(),
    [],
  );

  // --------------------------------------------- environment facts (D1/D2)
  const extractor = new MemoryExtractor();
  const winEnv = createEnvironment({
    os: "windows",
    shell: "powershell",
    cwd: "C:\\work",
    tools: ["git"],
  });
  const facts = extractor.environmentFacts(winEnv);
  assert.ok(facts.length >= 3, "os/shell/cwd/tools facts are expected");
  assert.ok(
    facts.every((fact) => fact.status === "candidate"),
    "an observed fact must not be born trusted",
  );
  const toolsFact = facts.find((fact) => fact.data.factKind === "tools");
  assert.ok(toolsFact, "tools fact must be keyed by kind");
  assert.deepEqual(toolsFact?.data.factValues, ["git"]);
  assert.equal(toolsFact?.data.factMode, "union");

  // Multi-valued facts accumulate into ONE entry instead of forking.
  const factDb = new MemoryDatabase({ store: new InMemoryStore() });
  for (const fact of extractor.environmentFacts(winEnv)) {
    mergeIntoDatabase(factDb, fact);
  }
  const grownEnv = createEnvironment({
    os: "windows",
    shell: "powershell",
    cwd: "C:\\work",
    tools: ["git", "docker"],
  });
  for (const fact of extractor.environmentFacts(grownEnv)) {
    mergeIntoDatabase(factDb, fact);
  }
  const toolEntries = factDb.all().filter((entry) => entry.data.factKind === "tools");
  assert.equal(toolEntries.length, 1, "tool facts must merge, not duplicate");
  assert.deepEqual(toolEntries[0].data.factValues, ["git", "docker"]);

  // Single-valued facts take the freshest value: a new cwd replaces, never adds.
  const movedEnv = createEnvironment({
    os: "windows",
    shell: "powershell",
    cwd: "D:\\other",
    tools: ["git", "docker"],
  });
  for (const fact of extractor.environmentFacts(movedEnv)) {
    mergeIntoDatabase(factDb, fact);
  }
  const cwdEntries = factDb.all().filter((entry) => entry.data.factKind === "cwd");
  assert.equal(cwdEntries.length, 1, "a new working directory must replace the old fact");
  assert.match(cwdEntries[0].text, /D:\\other/);

  // ------------------------------------------------- fact ageing (D3)
  const staleDb = new MemoryDatabase({ store: new InMemoryStore() });
  const oldStamp = Date.now() - 200 * 86_400_000;
  const oldFact = createMemoryEntry({
    type: "fact",
    text: "Рабочая директория: C:\\ancient",
    environment: winEnv,
    data: {
      factKind: "cwd",
      factLabel: "Рабочая директория",
      factValues: ["C:\\ancient"],
      factMode: "replace",
    },
  });
  const staleFact = { ...oldFact, createdAt: oldStamp, updatedAt: oldStamp, lastUsedAt: oldStamp };
  // A different fact kind so the two entries stay separate (same-kind facts merge,
  // and a pinned entry would then legitimately keep the merged one alive).
  const pinnedFact = {
    ...oldFact,
    id: "fact-pinned",
    text: "Используемые инструменты: git",
    data: {
      factKind: "tools",
      factLabel: "Используемые инструменты",
      factValues: ["git"],
      factMode: "union" as const,
    },
    createdAt: oldStamp,
    updatedAt: oldStamp,
    lastUsedAt: oldStamp,
    pinned: true,
  };
  staleDb.upsertMany([staleFact, pinnedFact]);
  const consolidationStats = consolidateDatabase(staleDb, { now: Date.now() });
  assert.ok(consolidationStats.pruned >= 1, "an ancient unused fact must be pruned");
  assert.equal(staleDb.has(staleFact.id), false);
  assert.equal(staleDb.has(pinnedFact.id), true, "a pinned fact must survive pruning");

  // ------------------------------------- two-window persistence (D6)
  const windowDir = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-memory-windows-"));
  try {
    const sharedFile = path.join(windowDir, "shared.json");
    const windowA = new JsonFileStore(sharedFile);
    const windowB = new JsonFileStore(sharedFile);
    await windowA.save([]);
    assert.deepEqual(await windowA.load(), []);

    // Another Tabby window learns something while we are running.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const foreign = createMemoryEntry({
      type: "fact",
      text: "ОС: linux",
      data: { factKind: "os", factLabel: "ОС", factValues: ["linux"], factMode: "replace" },
    });
    await windowB.save([foreign]);

    // Our own snapshot does not know about it — it must still survive.
    await windowA.save([]);
    const merged = await new JsonFileStore(sharedFile).load();
    assert.equal(merged.length, 1, "an entry created by another window must not be lost");
    assert.equal(merged[0].id, foreign.id);

    // What we pruned on purpose must NOT come back.
    const prunedFile = path.join(windowDir, "pruned.json");
    const prunedEntry = createMemoryEntry({
      type: "fact",
      text: "ОС: windows",
      data: { factKind: "os", factLabel: "ОС", factValues: ["windows"], factMode: "replace" },
    });
    await new JsonFileStore(prunedFile).save([prunedEntry]);
    const windowC = new JsonFileStore(prunedFile);
    await windowC.load();
    await windowC.save([]);
    assert.equal(
      (await new JsonFileStore(prunedFile).load()).length,
      0,
      "a deliberately pruned entry must stay pruned",
    );
  } finally {
    fs.rmSync(windowDir, { recursive: true, force: true });
  }

  // ------------------------------------------ secret redaction (D7)
  // Synthetic, part-assembled samples (never real credentials).
  const fakeTelegramToken = ["1234567890", "AAF", "fake", "Fake", "Fake", "Fake", "Fake", "Fake"].join("");
  const telegramRedacted = redactSecrets(`TELEGRAM_TOKEN=${fakeTelegramToken}`);
  assert.ok(
    !telegramRedacted.includes("AAFfakeFake"),
    "a Telegram bot token must not reach memory.json",
  );
  const fakeGithubToken = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");
  assert.ok(redactSecrets(fakeGithubToken).includes("ghp_***"));
  const fakeSlackToken = ["xoxb", "0000000000", "fakefakefake"].join("-");
  assert.ok(redactSecrets(fakeSlackToken).includes("xox*-***"));
  const fakeNpmToken = ["npm", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
  assert.ok(redactSecrets(fakeNpmToken).includes("npm_***"));

  console.log("memory tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
