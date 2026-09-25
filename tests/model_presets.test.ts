import assert from "node:assert/strict";
import {
  buildReasoningParameters,
  describeReasoning,
  isReasoningEffort,
  mergeReasoningParameters,
  resolveReasoningStyle,
} from "../src/lib/model_presets";
import {
  AIProviderConfig,
  DEFAULT_PROVIDER_ID,
  DEFAULT_PROVIDERS,
  cloneProviders,
  createProviderId,
  findProvider,
} from "../src/lib/providers";

// ----------------------------------------------------------------- providers
// The shipped plugin must not contain preselected providers, keys or URLs.
assert.deepEqual(DEFAULT_PROVIDERS, [], "в сборке нет предустановленных провайдеров");
assert.equal(DEFAULT_PROVIDER_ID, "");
assert.ok(!JSON.stringify(DEFAULT_PROVIDERS).includes("sk-"));

const custom: AIProviderConfig[] = [
  { id: "a", label: "A", endpoint: "https://api.example.com", model: "m-a", apiToken: "test-a" },
  { id: "b", label: "B", endpoint: "http://127.0.0.1:4000", model: "m-b", apiToken: "" },
];

assert.equal(findProvider(custom, "a")?.model, "m-a");
assert.equal(findProvider(custom, "nope"), undefined);
assert.equal(findProvider(undefined, "a"), undefined);
assert.equal(findProvider([], "a"), undefined);

// clone не делит ссылки с исходным массивом.
const cloned = cloneProviders(custom);
assert.notEqual(cloned, custom);
cloned[0].apiToken = "changed";
assert.equal(custom[0].apiToken, "test-a");

// id нового провайдера уникален.
const id = createProviderId(custom);
assert.ok(!custom.some((provider) => provider.id === id));
assert.ok(createProviderId([]).startsWith("provider-"));

// ----------------------------------------------------------------- reasoning
assert.equal(isReasoningEffort("off"), true);
assert.equal(isReasoningEffort("max"), true);
assert.equal(isReasoningEffort("ultra"), false);
assert.equal(isReasoningEffort(undefined), false);

assert.equal(resolveReasoningStyle("https://api.deepseek.com", "any"), "deepseek");
assert.equal(resolveReasoningStyle("https://gateway.example.com/mcp/kiborg", "Kibborg_Flash_v5.7"), "llamacpp");
assert.equal(resolveReasoningStyle("http://127.0.0.1:8083/v1", "some-model"), "llamacpp");
assert.equal(resolveReasoningStyle("http://127.0.0.1:8093", "X"), "llamacpp");
assert.equal(resolveReasoningStyle("http://127.0.0.1:8086", "Kibborg_Worker_smart"), "llamacpp");
assert.equal(resolveReasoningStyle("https://api.openai.com", "gpt-4.1"), "none");

assert.deepEqual(buildReasoningParameters("deepseek", "high"), { reasoning_effort: "high" });
assert.deepEqual(buildReasoningParameters("deepseek", "off"), { reasoning_effort: "none" });
assert.deepEqual(buildReasoningParameters("llamacpp", "off"), {
  chat_template_kwargs: { enable_thinking: false },
});
assert.deepEqual(buildReasoningParameters("llamacpp", "max"), {
  chat_template_kwargs: { enable_thinking: true },
  thinking_budget_tokens: 16384,
});
assert.deepEqual(buildReasoningParameters("none", "max"), {});

assert.deepEqual(
  mergeReasoningParameters(
    { temperature: 0.2, chat_template_kwargs: { enable_thinking: true, custom_flag: 1 } },
    "llamacpp",
    "off",
  ),
  { temperature: 0.2, chat_template_kwargs: { enable_thinking: false, custom_flag: 1 } },
);
assert.deepEqual(
  mergeReasoningParameters({ reasoning_effort: "low", top_p: 0.9 }, "deepseek", "max"),
  { reasoning_effort: "max", top_p: 0.9 },
);
assert.deepEqual(mergeReasoningParameters(undefined, "none", "high"), {});

assert.match(describeReasoning("deepseek", "off"), /none/);
assert.match(describeReasoning("llamacpp", "high"), /4096/);
assert.match(describeReasoning("none", "high"), /не передаётся/);

console.log("model_presets tests passed");
