import assert from "node:assert/strict";
import {
  CUSTOM_PRESET_ID,
  MODEL_PRESETS,
  buildReasoningParameters,
  describeReasoning,
  findModelPreset,
  isReasoningEffort,
  mergeReasoningParameters,
  resolveReasoningStyle,
} from "../src/lib/model_presets";

// The providers the settings page must offer out of the box.
const kibborg = findModelPreset("kibborg");
assert.equal(kibborg?.endpoint, "http://127.0.0.1:8083");
assert.equal(kibborg?.model, "Kibborg_Flash_v5.7");
assert.equal(
  kibborg?.reasoningStyle,
  "gateway",
  "the engine gateway swallows reasoning switches, so it must not claim a dialect",
);
assert.equal(kibborg?.requiresToken, false);

// Direct brain: real streaming and working reasoning on the same alias.
const kibborgDirect = findModelPreset("kibborg-direct");
assert.equal(kibborgDirect?.endpoint, "http://127.0.0.1:8093");
assert.equal(kibborgDirect?.model, "Kibborg_Flash_v5.7");
assert.equal(kibborgDirect?.contextWindowTokens, 262144);
assert.equal(kibborgDirect?.reasoningStyle, "llamacpp");
assert.equal(kibborgDirect?.requiresToken, false);

// Kibborg helpers ("помощники") re-expose the worker servers.
const workerSmart = findModelPreset("kibborg-worker-smart");
assert.equal(workerSmart?.endpoint, "http://127.0.0.1:8086");
assert.equal(workerSmart?.model, "Kibborg_Worker_smart");
assert.equal(workerSmart?.contextWindowTokens, 40960);
assert.equal(workerSmart?.reasoningStyle, "llamacpp");

const workerFast = findModelPreset("kibborg-worker-fast");
assert.equal(workerFast?.endpoint, "http://127.0.0.1:8084");
assert.equal(workerFast?.model, "Kibborg_Worker_fast");
assert.equal(workerFast?.contextWindowTokens, 32768);

const deepseekFlash = findModelPreset("deepseek-flash");
assert.equal(deepseekFlash?.endpoint, "https://api.deepseek.com");
assert.equal(deepseekFlash?.model, "deepseek-flash");
assert.equal(deepseekFlash?.reasoningStyle, "deepseek");
assert.equal(deepseekFlash?.requiresToken, true);

const deepseekPro = findModelPreset("deepseek-v4-pro");
assert.equal(deepseekPro?.model, "deepseek-v4-pro");

assert.equal(findModelPreset(CUSTOM_PRESET_ID), undefined);
assert.equal(findModelPreset(undefined), undefined);
assert.ok(MODEL_PRESETS.length >= 6);

assert.equal(isReasoningEffort("off"), true);
assert.equal(isReasoningEffort("max"), true);
assert.equal(isReasoningEffort("ultra"), false);
assert.equal(isReasoningEffort(undefined), false);

// A preset decides the dialect; a hand-typed endpoint is sniffed.
assert.equal(resolveReasoningStyle("", "", "kibborg"), "gateway");
assert.equal(resolveReasoningStyle("", "", "kibborg-direct"), "llamacpp");
assert.equal(resolveReasoningStyle("", "", "kibborg-worker-fast"), "llamacpp");
assert.equal(resolveReasoningStyle("", "", "deepseek-flash"), "deepseek");
assert.equal(resolveReasoningStyle("https://api.deepseek.com", "any"), "deepseek");
assert.equal(resolveReasoningStyle("http://127.0.0.1:8083", "X"), "gateway");
assert.equal(resolveReasoningStyle("http://127.0.0.1:8093", "X"), "llamacpp");
assert.equal(resolveReasoningStyle("http://127.0.0.1:8086", "X"), "llamacpp");
assert.equal(resolveReasoningStyle("https://api.openai.com", "gpt-4.1"), "none");
assert.equal(resolveReasoningStyle("", "", CUSTOM_PRESET_ID), "none");

assert.deepEqual(buildReasoningParameters("deepseek", "high"), {
  reasoning_effort: "high",
});
assert.deepEqual(buildReasoningParameters("deepseek", "off"), {
  reasoning_effort: "none",
});
assert.deepEqual(buildReasoningParameters("llamacpp", "off"), {
  chat_template_kwargs: { enable_thinking: false },
});
assert.deepEqual(buildReasoningParameters("llamacpp", "max"), {
  chat_template_kwargs: { enable_thinking: true },
  thinking_budget_tokens: 16384,
});
assert.deepEqual(
  buildReasoningParameters("gateway", "max"),
  {},
  "nothing must be sent through the gateway",
);
assert.deepEqual(buildReasoningParameters("none", "max"), {});

// The reasoning choice wins over a stale value in the JSON box, while
// unrelated keys and sibling chat-template switches survive.
assert.deepEqual(
  mergeReasoningParameters(
    {
      temperature: 0.2,
      chat_template_kwargs: { enable_thinking: true, custom_flag: 1 },
    },
    "llamacpp",
    "off",
  ),
  {
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false, custom_flag: 1 },
  },
);

assert.deepEqual(
  mergeReasoningParameters({ reasoning_effort: "low", top_p: 0.9 }, "deepseek", "max"),
  { reasoning_effort: "max", top_p: 0.9 },
);

assert.deepEqual(mergeReasoningParameters(undefined, "none", "high"), {});

assert.match(describeReasoning("deepseek", "off"), /none/);
assert.match(describeReasoning("llamacpp", "high"), /4096/);
assert.match(
  describeReasoning("gateway", "max"),
  /не пробрасывает/,
  "the gateway hint must explain why nothing is sent",
);
assert.match(describeReasoning("none", "high"), /не передаётся/);

console.log("model_presets tests passed");

