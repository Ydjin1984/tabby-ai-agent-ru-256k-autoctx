/**
 * Memory Manager — the orchestrator of the memory layer.
 *
 * It owns the store, the four memory layers, extraction and consolidation, and
 * exposes the tiny [[MemoryBridge]] surface the chat session talks to. Every
 * public method is defensive: memory is an enhancement, so a failure here must
 * never break the agent.
 */

import {
  CommandOutcome,
  EnvironmentSnapshot,
  MemoryBridge,
  MemoryEntry,
  MemoryQuery,
  ProcedureStatus,
  RankedMemory,
  TaskOutcome,
  ToolObservation,
} from "./types";
import {
  createEnvironment,
  emptyEnvironment,
  environmentKey,
  inferEnvironmentFromCommand,
} from "./environment";
import { SessionMemory } from "./session_memory";
import { InMemoryStore, MemoryDatabase, MemoryStore } from "./store";
import { EpisodicMemory } from "./episodic_memory";
import { ProceduralMemory } from "./procedural_memory";
import { SemanticMemory } from "./semantic_memory";
import { LessonSynthesizer, MemoryExtractor } from "./extractor";
import { retrieveMemories } from "./retriever";
import {
  DEFAULT_MEMORY_CONTEXT_TOKENS,
  buildMemoryContext,
} from "./context_builder";
import { ConsolidationStats, consolidateDatabase } from "./consolidation";
import {
  bumpEntryUsage,
  createMemoryEntry,
  embedEntry,
  entryEmbeddingText,
  mergeIntoDatabase,
  redactMemoryEntry,
  stampEmbedding,
} from "./entry";
import {
  EmbeddingProvider,
  HashedEmbeddingProvider,
} from "./embeddings";
import { computeSuccessScore, successRate } from "./scoring";
import {
  TaskMetrics,
  computeTaskMetrics,
} from "./task_outcome";
import { evaluatePostcondition } from "./postconditions";
import { redactSecrets } from "./secrets";
import {
  classifyOutcome,
  commandSignature,
  commandTool,
  embedText,
  extractErrorSignature,
  sharesProblemFamily,
  truncate,
} from "./text";

export interface MemoryManagerOptions {
  store?: MemoryStore;
  enabled?: boolean;
  now?: () => number;
  retrievalLimit?: number;
  contextTokenBudget?: number;
  consolidationIntervalMs?: number;
  maxEntries?: number;
  synthesizer?: LessonSynthesizer;
  embeddingProvider?: EmbeddingProvider;
  onPersistError?: (error: unknown) => void;
}

export interface MemoryStats {
  enabled: boolean;
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  environment: EnvironmentSnapshot;
  sessionAttempts: number;
}

export class MemoryManager implements MemoryBridge {
  private db: MemoryDatabase;
  private session: SessionMemory;
  private episodic: EpisodicMemory;
  private procedural: ProceduralMemory;
  private semantic: SemanticMemory;
  private extractor: MemoryExtractor;
  private environment: EnvironmentSnapshot;
  private enabledFlag: boolean;
  private now: () => number;
  private retrievalLimit: number;
  private contextTokenBudget: number;
  private consolidationIntervalMs: number;
  private maxEntries: number;
  private lastConsolidationAt = 0;
  private lastFactsKey = "";
  /** Environment facts awaiting embedding by the active provider. */
  private pendingFacts: MemoryEntry[] = [];
  private embeddingProvider: EmbeddingProvider;
  private embeddingCache = new Map<string, number[]>();
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(options: MemoryManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.enabledFlag = options.enabled ?? true;
    this.retrievalLimit = options.retrievalLimit ?? 6;
    this.contextTokenBudget = options.contextTokenBudget ?? DEFAULT_MEMORY_CONTEXT_TOKENS;
    this.consolidationIntervalMs = options.consolidationIntervalMs ?? 10 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 500;
    this.environment = emptyEnvironment();
    this.embeddingProvider = options.embeddingProvider ?? new HashedEmbeddingProvider();

    this.db = new MemoryDatabase({
      store: options.store ?? new InMemoryStore(),
      onPersistError: options.onPersistError,
    });
    this.session = new SessionMemory({ now: this.now });
    this.episodic = new EpisodicMemory(this.db);
    this.procedural = new ProceduralMemory(this.db);
    this.semantic = new SemanticMemory(this.db);
    this.extractor = new MemoryExtractor(options.synthesizer);
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(value: boolean): void {
    this.enabledFlag = value;
  }

  setRetrievalLimit(value: number): void {
    if (Number.isFinite(value) && value > 0) {
      this.retrievalLimit = Math.floor(value);
    }
  }

  setContextTokenBudget(value: number): void {
    if (Number.isFinite(value) && value > 0) {
      this.contextTokenBudget = Math.floor(value);
    }
  }

  /** Swap the embedding provider; stale vectors are re-indexed in the background. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    if (provider.id() === this.embeddingProvider.id()) {
      return;
    }
    this.embeddingProvider = provider;
    this.embeddingCache.clear();
    if (this.initialized && !this.isHashedProvider()) {
      void this.reindexEmbeddings().catch(() => undefined);
    }
  }

  getEmbeddingProviderId(): string {
    return this.embeddingProvider.id();
  }

  setEnvironment(environment: EnvironmentSnapshot | Partial<EnvironmentSnapshot>): void {
    this.environment = createEnvironment(environment);
    this.session.setEnvironment(this.environment);
  }

  getEnvironment(): EnvironmentSnapshot {
    return this.environment;
  }

  getSession(): SessionMemory {
    return this.session;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  private async doInitialize(): Promise<void> {
    await this.db.load();
    if (this.isHashedProvider()) {
      this.db.replaceAll(this.db.all().map((entry) => embedEntry(redactMemoryEntry(entry))));
    } else {
      this.db.replaceAll(this.db.all().map((entry) => redactMemoryEntry(entry)));
    }
    this.session.setEnvironment(this.environment);
    // Consolidation merges duplicate facts and drops their stale vectors, so it
    // must run BEFORE the re-index and the flag must already be set for the
    // re-index request inside `maybeConsolidate` to be honoured.
    this.initialized = true;
    this.maybeConsolidate(true);
    await this.requestReindex();
    await this.db.flush();
  }

  /**
   * Re-index guard: several call sites can discover stale vectors at once
   * (startup, consolidation, fact merging), and they must not race each other
   * with `replaceAll`.
   */
  private reindexPromise: Promise<number> | null = null;

  private requestReindex(): Promise<number> | null {
    if (this.isHashedProvider()) {
      return null;
    }
    if (!this.reindexPromise) {
      this.reindexPromise = this.reindexEmbeddings()
        .catch(() => 0)
        .finally(() => {
          this.reindexPromise = null;
        });
    }
    return this.reindexPromise;
  }

  private isHashedProvider(): boolean {
    return this.embeddingProvider.id().startsWith("hashed-v");
  }

  private async embed(text: string): Promise<number[]> {
    const key = text ?? "";
    const cached = this.embeddingCache.get(key);
    if (cached) {
      return cached;
    }
    let vector: number[] = [];
    try {
      vector = await this.embeddingProvider.embed(key);
    } catch {
      vector = [];
    }
    if (!vector?.length) {
      vector = embedText(key);
    }
    if (this.embeddingCache.size > 2000) {
      this.embeddingCache.clear();
    }
    this.embeddingCache.set(key, vector);
    return vector;
  }

  /**
   * Re-embed every entry whose vector was produced by a different provider or
   * with different dimensions. Batched when the provider supports it.
   */
  async reindexEmbeddings(): Promise<number> {
    const providerId = this.embeddingProvider.id();
    const dims = this.embeddingProvider.dimensions();
    const entries = this.db.all().map((entry) => redactMemoryEntry(entry));

    if (this.isHashedProvider()) {
      this.db.replaceAll(entries.map((entry) => embedEntry(entry)));
      return this.db.size();
    }

    const stale = entries.filter(
      (entry) =>
        entry.embeddingModel !== providerId ||
        (dims > 0 && entry.embeddingDimensions !== dims),
    );
    if (!stale.length) {
      this.db.replaceAll(entries);
      return 0;
    }

    const texts = stale.map((entry) => entryEmbeddingText(entry));
    let vectors: number[][] = [];
    try {
      vectors = this.embeddingProvider.embedBatch
        ? await this.embeddingProvider.embedBatch(texts)
        : await Promise.all(texts.map((text) => this.embeddingProvider.embed(text)));
    } catch {
      vectors = [];
    }

    const byId = new Map<string, number[]>();
    stale.forEach((entry, index) => {
      const vector = vectors[index];
      if (vector?.length) {
        byId.set(entry.id, vector);
      }
    });

    this.db.replaceAll(
      entries.map((entry) => {
        const vector = byId.get(entry.id);
        return vector
          ? stampEmbedding(entry, vector, providerId, dims || vector.length)
          : entry;
      }),
    );
    await this.db.flush();
    return byId.size;
  }

  // ------------------------------------------------------------------
  // MemoryBridge
  // ------------------------------------------------------------------

  async buildContext(userMessage: string): Promise<string | null> {
    if (!this.enabledFlag) {
      return null;
    }
    try {
      await this.initialize();
      const now = this.now();
      const snapshot = this.session.snapshot();
      const lastAttempt = snapshot.attempts[snapshot.attempts.length - 1];
      const queryText = `${userMessage} ${snapshot.goal}`.trim();
      const query: MemoryQuery = {
        text: queryText,
        embedding: await this.embed(queryText),
        environment: this.environment,
        now,
        limit: this.retrievalLimit,
        tool: lastAttempt ? commandTool(lastAttempt.normalizedCommand) : undefined,
        errorSignature: lastAttempt?.errorSignature ?? null,
        cwdType: this.environment.cwdType || undefined,
      };

      const ranked = retrieveMemories(this.db.all(), query);
      if (ranked.some((item) => item.entry.type !== "fact")) {
        this.session.markMemoryAssisted();
      }
      for (const item of ranked) {
        const bumped = bumpEntryUsage(item.entry, now);
        this.db.upsert(bumped);
        item.entry = bumped;
      }
      if (ranked.length) {
        this.db.schedulePersist();
      }

      return buildMemoryContext({
        environment: this.environment,
        session: snapshot,
        memories: ranked,
        tokenBudget: this.contextTokenBudget,
      });
    } catch {
      return null;
    }
  }

  async observeUserMessage(text: string): Promise<void> {
    if (!this.enabledFlag) {
      return;
    }
    try {
      await this.initialize();
      this.session.recordUserMessage(text);
      this.session.setGoal(text);
    } catch {
      // best-effort
    }
  }

  async observeAssistantMessage(text: string): Promise<void> {
    if (!this.enabledFlag) {
      return;
    }
    try {
      await this.initialize();
      this.session.setLastAssistant(text);
    } catch {
      // best-effort
    }
  }

  /** Close the current task, persist its outcome and update task metrics. */
  async finishTurn(): Promise<void> {
    if (!this.enabledFlag) {
      return;
    }
    try {
      await this.initialize();
      const outcome = this.session.finalizeCurrentTask();
      if (!outcome) {
        return;
      }
      const now = this.now();
      const redactedOutcome: TaskOutcome = {
        ...outcome,
        goal: redactSecrets(outcome.goal),
        successfulStrategy: outcome.successfulStrategy
          ? redactSecrets(outcome.successfulStrategy)
          : null,
        failedStrategies: outcome.failedStrategies.map((command) => redactSecrets(command)),
        attempts: outcome.attempts.map((attempt) => ({
          ...attempt,
          command: redactSecrets(attempt.command),
        })),
      };
      const entry = createMemoryEntry({
        type: "task",
        text: redactedOutcome.goal || "Задача без описания",
        solution: redactedOutcome.successfulStrategy ?? "",
        environment: this.environment,
        successCount: redactedOutcome.completed ? 1 : 0,
        failureCount: redactedOutcome.completed ? 0 : 1,
        score: redactedOutcome.completionConfidence,
        sessionIds: [redactedOutcome.sessionId],
        status: "trusted",
        provenance: {
          sessionId: redactedOutcome.sessionId,
          taskId: redactedOutcome.taskId,
          command: redactedOutcome.successfulStrategy ?? "",
          environmentKey: environmentKey(this.environment),
        },
        data: { taskOutcome: redactedOutcome },
        now,
      });
      mergeIntoDatabase(this.db, entry, now);
      this.maybeConsolidate(false);
      this.db.schedulePersist();
    } catch {
      // best-effort
    }
  }

  async observeToolResult(observation: ToolObservation): Promise<void> {
    if (!this.enabledFlag || observation.toolName !== "run_shell_command") {
      return;
    }
    try {
      await this.initialize();
      const command = String(observation.args?.command ?? "").trim();
      if (!command) {
        return;
      }
      const now = this.now();
      const rawOutput = truncate(observation.output ?? "", 8000);
      const output = redactSecrets(rawOutput);
      const normalized = commandSignature(command);

      const postcondition = evaluatePostcondition(command, output);
      let outcome: CommandOutcome = observation.ok
        ? classifyOutcome(output)
        : "failure";
      let errorSignature = observation.ok
        ? extractErrorSignature(output)
        : extractErrorSignature(observation.errorMessage || output) ?? "tool_error";

      // A negative postcondition means the command ran but did not achieve its
      // goal (e.g. exit 0 with "nothing to commit") — do not trust exit code.
      if (postcondition.matched === false && outcome !== "failure") {
        outcome = "failure";
        errorSignature = errorSignature ?? "postcondition_failed";
      }

      const priorFailures = this.session
        .snapshot()
        .attempts.filter((attempt) => attempt.outcome === "failure");
      const relatedPrior = priorFailures.filter((failure) =>
        sharesProblemFamily(failure, { normalizedCommand: normalized, errorSignature }),
      );

      if (outcome === "unknown" && observation.ok && relatedPrior.length > 0) {
        outcome = "success";
      }
      const transitionFix = outcome === "success" && relatedPrior.length > 0;
      const priorFailureSignature = relatedPrior.length
        ? relatedPrior[relatedPrior.length - 1].errorSignature
        : null;
      const expectedOutputMatched =
        postcondition.matched === true || (postcondition.matched === null && output.trim().length > 0);
      const successScore =
        outcome === "success"
          ? computeSuccessScore({
              exitCodeZero: true,
              expectedOutputMatched,
              validated: Boolean(priorFailureSignature) && errorSignature === null,
              goalCompleted: transitionFix,
              userConfirmed: false,
            })
          : 0;

      const environment = inferEnvironmentFromCommand(command, this.environment);
      this.environment = environment;
      this.session.setEnvironment(environment);

      this.session.recordAttempt({
        command: redactSecrets(command),
        outcome,
        output,
        errorSignature,
        successScore,
        postconditionMet: postcondition.matched,
        timestamp: now,
      });

      this.procedural.reinforceCommand(normalized, outcome === "success", now);

      this.recordEnvironmentFacts(environment, now);
      await this.flushEnvironmentFacts();
      await this.maybeExtract(now);
      this.maybeConsolidate(false);
      this.db.schedulePersist();
    } catch {
      // best-effort
    }
  }

  /**
   * Environment facts are collected synchronously per command; embedding them
   * with a remote provider is async, so they are queued and flushed here.
   */
  private async flushEnvironmentFacts(): Promise<void> {
    if (!this.pendingFacts.length) {
      return;
    }
    const queued = this.pendingFacts;
    this.pendingFacts = [];
    const now = this.now();
    const drafts = await this.embedDrafts(queued.map((entry) => redactMemoryEntry(entry)));
    for (const entry of drafts) {
      mergeIntoDatabase(this.db, entry, now);
    }
    // A merged fact got a new text, so its stored vector is stale.
    void this.requestReindex();
  }

  // ------------------------------------------------------------------
  // Extraction / consolidation
  // ------------------------------------------------------------------

  private async maybeExtract(now: number): Promise<void> {
    const snapshot = this.session.snapshot();
    const key = this.extractor.extractionKey(snapshot);
    if (!key || this.session.hasExtracted(key)) {
      return;
    }

    const result = await this.extractor.extractFromSession(snapshot, now);
    if (!result.entries.length) {
      return;
    }
    const drafts = await this.embedDrafts(result.entries.map((entry) => redactMemoryEntry(entry)));
    for (const entry of drafts) {
      mergeIntoDatabase(this.db, entry, now);
    }
    this.session.markExtracted(result.key ?? key);
  }

  /** Stamp fresh drafts with the configured provider's vectors. */
  private async embedDrafts(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (this.isHashedProvider()) {
      return entries;
    }
    const providerId = this.embeddingProvider.id();
    const dims = this.embeddingProvider.dimensions();
    return Promise.all(
      entries.map(async (entry) => {
        try {
          const vector = await this.embed(entryEmbeddingText(entry));
          return vector?.length ? stampEmbedding(entry, vector, providerId, dims || vector.length) : entry;
        } catch {
          return entry;
        }
      }),
    );
  }

  private recordEnvironmentFacts(environment: EnvironmentSnapshot, now: number): void {
    const key = `${environmentKey(environment)}|${environment.cwd}|${environment.tools.join(",")}`;
    if (key === this.lastFactsKey) {
      return;
    }
    this.lastFactsKey = key;
    // Queued instead of written directly: facts must carry the active
    // provider's vectors (Kibborg_Embed_v1), not the offline hashed ones.
    this.pendingFacts.push(...this.extractor.environmentFacts(environment, now));
  }

  private maybeConsolidate(force: boolean): void {
    const now = this.now();
    if (!force && now - this.lastConsolidationAt < this.consolidationIntervalMs) {
      return;
    }
    consolidateDatabase(this.db, { now, maxEntries: this.maxEntries });
    this.lastConsolidationAt = now;
    this.db.schedulePersist();
    // Merging rewrites fact texts; their vectors are stale until re-embedded.
    if (this.initialized) {
      void this.requestReindex();
    }
  }

  /** Force a consolidation pass (used by the UI / tests). */
  async consolidate(): Promise<ConsolidationStats> {
    await this.initialize();
    const stats = consolidateDatabase(this.db, { now: this.now(), maxEntries: this.maxEntries });
    this.lastConsolidationAt = this.now();
    await this.requestReindex();
    await this.db.flush();
    return stats;
  }

  // ------------------------------------------------------------------
  // Introspection / lifecycle
  // ------------------------------------------------------------------

  listMemories(): MemoryEntry[] {
    return this.db.all();
  }

  findByType(type: MemoryEntry["type"]): MemoryEntry[] {
    return this.db.byType(type);
  }

  findSimilarEpisodes(text: string, limit = 5): RankedMemory[] {
    return this.episodic.findSimilar(text, this.environment, this.now(), limit);
  }

  findApplicableProcedures(text: string, limit = 5): RankedMemory[] {
    return this.procedural.findApplicable(text, this.environment, this.now(), limit);
  }

  findFacts(text: string, limit = 5): RankedMemory[] {
    return this.semantic.findFacts(text, this.environment, this.now(), limit);
  }

  findLessons(text: string, limit = 4): RankedMemory[] {
    return this.semantic.findLessons(text, this.environment, this.now(), limit);
  }

  deleteMemory(id: string): boolean {
    if (!this.db.has(id)) {
      return false;
    }
    this.db.remove(id);
    this.db.schedulePersist();
    return true;
  }

  getStats(): MemoryStats {
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const entry of this.db.all()) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    }
    return {
      enabled: this.enabledFlag,
      total: this.db.size(),
      byType,
      byStatus,
      environment: this.environment,
      sessionAttempts: this.session.snapshot().attempts.length,
    };
  }

  getTaskOutcomes(): TaskOutcome[] {
    return this.db
      .byType("task")
      .map((entry) => entry.data?.taskOutcome as TaskOutcome | undefined)
      .filter((outcome): outcome is TaskOutcome => Boolean(outcome));
  }

  getMetrics(): TaskMetrics {
    const outcomes = this.getTaskOutcomes();
    const procedures = this.db.byType("procedure");
    const reused = procedures.filter((entry) => entry.useCount > 0).length;
    const bad = procedures.filter(
      (entry) =>
        entry.successCount + entry.failureCount >= 3 &&
        successRate(entry.successCount, entry.failureCount) < 0.5,
    ).length;
    return computeTaskMetrics(outcomes, {
      procedureReuseRate: procedures.length ? reused / procedures.length : 0,
      badMemoryRate: procedures.length ? bad / procedures.length : 0,
    });
  }

  /** Search / filter for the Memory Inspector. */
  searchMemories(
    options: {
      query?: string;
      type?: MemoryEntry["type"] | "all";
      status?: ProcedureStatus | "all";
      limit?: number;
    } = {},
  ): MemoryEntry[] {
    const query = (options.query ?? "").trim().toLowerCase();
    const type = options.type ?? "all";
    const status = options.status ?? "all";
    return this.db
      .all()
      .filter((entry) => (type === "all" ? true : entry.type === type))
      .filter((entry) => (status === "all" ? true : entry.status === status))
      .filter((entry) =>
        query
          ? `${entry.text} ${entry.solution} ${entry.action} ${entry.tags.join(" ")}`
              .toLowerCase()
              .includes(query)
          : true,
      )
      .sort(
        (a, b) =>
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt,
      )
      .slice(0, options.limit ?? 200);
  }

  getMemory(id: string): MemoryEntry | null {
    return this.db.get(id) ?? null;
  }

  setMemoryStatus(id: string, status: ProcedureStatus): MemoryEntry | null {
    const entry = this.db.get(id);
    if (!entry) {
      return null;
    }
    const updated: MemoryEntry = { ...entry, status, updatedAt: this.now() };
    this.db.upsert(updated);
    this.db.schedulePersist();
    return updated;
  }

  setMemoryDisabled(id: string, disabled: boolean): MemoryEntry | null {
    const entry = this.db.get(id);
    if (!entry) {
      return null;
    }
    const updated: MemoryEntry = { ...entry, disabled, updatedAt: this.now() };
    this.db.upsert(updated);
    this.db.schedulePersist();
    return updated;
  }

  setMemoryPinned(id: string, pinned: boolean): MemoryEntry | null {
    const entry = this.db.get(id);
    if (!entry) {
      return null;
    }
    const updated: MemoryEntry = { ...entry, pinned, updatedAt: this.now() };
    this.db.upsert(updated);
    this.db.schedulePersist();
    return updated;
  }

  async clear(): Promise<void> {
    await this.initialize();
    this.db.replaceAll([]);
    this.session.reset();
    this.lastFactsKey = "";
    await this.db.flush();
  }

  async flush(): Promise<void> {
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // ignore load failures on shutdown
      }
    }
    await this.db.flush();
  }
}
