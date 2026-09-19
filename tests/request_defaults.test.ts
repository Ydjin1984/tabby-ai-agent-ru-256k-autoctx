import assert from "node:assert/strict";
import {
  KIBBORG_SAMPLING_DEFAULTS,
  LOCAL_THINKING_BUDGET_LIMIT,
  THINKING_ANSWER_RESERVE_TOKENS,
  applyLocalRequestDefaults,
  isKibborgEndpoint,
  looksRepetitive,
  stripReasoningParameters,
} from "../src/lib/request_defaults";

// ----------------------------------------------------------------- endpoint
assert.equal(isKibborgEndpoint("http://127.0.0.1:8083"), true);
assert.equal(isKibborgEndpoint("http://127.0.0.1:8093"), true);
assert.equal(isKibborgEndpoint("http://127.0.0.1:8084"), true);
assert.equal(isKibborgEndpoint("http://kibborg.local:1234"), true);
assert.equal(isKibborgEndpoint("https://api.deepseek.com"), false);
assert.equal(isKibborgEndpoint("https://api.openai.com:443"), false);
assert.equal(isKibborgEndpoint(""), false);

// ------------------------------------------------------------------- strip
assert.deepEqual(
  stripReasoningParameters({
    temperature: 0.2,
    reasoning_effort: "high",
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 0,
    top_p: 0.9,
  }),
  { temperature: 0.2, top_p: 0.9 },
);

// ------------------------------- the gateway swallows reasoning switches
// (this is the config that made the brain loop: enable_thinking + budget 0)
const viaGateway = applyLocalRequestDefaults(
  {
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 0,
    temperature: 0.2,
    top_p: 0.9,
    top_k: 40,
  },
  "http://127.0.0.1:8083",
  "gateway",
);
assert.equal(viaGateway.chat_template_kwargs, undefined, "gateway must not receive thinking switches");
assert.equal(viaGateway.thinking_budget_tokens, undefined, "unlimited budget must be dropped");
assert.equal(viaGateway.temperature, 0.2, "explicit user values must win");
assert.equal(viaGateway.top_p, 0.9);
assert.equal(viaGateway.top_k, 40);
// Repetition protection and a generation cap are added for the local stack.
assert.equal(viaGateway.presence_penalty, KIBBORG_SAMPLING_DEFAULTS.presence_penalty);
assert.equal(viaGateway.frequency_penalty, KIBBORG_SAMPLING_DEFAULTS.frequency_penalty);
assert.equal(viaGateway.repeat_penalty, KIBBORG_SAMPLING_DEFAULTS.repeat_penalty);
assert.equal(viaGateway.max_tokens, 2048);

// -------------------------------------------- direct brain: thinking allowed
const direct = applyLocalRequestDefaults(
  {
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 0,
    temperature: 0.5,
  },
  "http://127.0.0.1:8093",
  "llamacpp",
);
assert.equal(direct.chat_template_kwargs.enable_thinking, true, "direct brain keeps user switches");
assert.equal(
  direct.thinking_budget_tokens,
  undefined,
  "thinking_budget_tokens: 0 means unlimited thinking for llama.cpp and must go",
);
assert.equal(direct.temperature, 0.5);
assert.equal(direct.top_p, KIBBORG_SAMPLING_DEFAULTS.top_p);
assert.equal(direct.max_tokens, 2048);

// ---------------------------------------------------- thinking needs room
// (measured: budget 2048 with max_tokens 2048 cut a planning task off empty)
const thinking = applyLocalRequestDefaults(
  {
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 2048,
    temperature: 0.2,
    top_p: 0.9,
    top_k: 40,
  },
  "http://127.0.0.1:8093",
  "llamacpp",
);
assert.equal(thinking.thinking_budget_tokens, 2048, "an explicit budget is kept");
assert.equal(
  thinking.max_tokens,
  2048 + THINKING_ANSWER_RESERVE_TOKENS,
  "max_tokens must cover the thinking budget plus the answer reserve",
);

// The "max" level (16384) is clamped on the local brain: otherwise the model
// generates for minutes and still gets cut off.
const maxed = applyLocalRequestDefaults(
  {
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 16384,
  },
  "http://127.0.0.1:8093",
  "llamacpp",
);
assert.equal(maxed.thinking_budget_tokens, LOCAL_THINKING_BUDGET_LIMIT);
assert.equal(maxed.max_tokens, LOCAL_THINKING_BUDGET_LIMIT + THINKING_ANSWER_RESERVE_TOKENS);

// ------------------------------------------------------------------ loops
const looped = [
  "Also, check the \"mercedes\" service via sc? Get-Service covers it.",
  "Also, check the \"mercedes\" service via sc? Get-Service covers it.",
  "Also, check the \"mercedes\" service via sc? Get-Service covers it.",
  "Also, check the \"mercedes\" service via sc? Get-Service covers it.",
  "Also, check the \"mercedes\" service via sc? Get-Service covers it.",
  "Also, check the \"mercedes\" service via sc? Get-Service covers it.",
  "Also, check the \"mercedes\" service via sc? Get-Service covers it.",
].join("\n");
assert.equal(looksRepetitive(looped), true, "a repeated block must be detected");

const healthy = [
  "Проверить список установленных программ через реестр Uninstall.",
  "Найти службы с именем, содержащим mercedes, через Get-Service.",
  "Проверить задачи планировщика и автозагрузку в ветках Run.",
  "Просмотреть каталоги Program Files и ProgramData на папки MB.",
  "Собрать отчёт и удалить найденные компоненты по одному.",
  "Зафиксировать результат проверки выводом команд.",
  "Проверить журнал событий на упоминания компонентов Mercedes.",
].join("\n");
assert.equal(looksRepetitive(healthy), false, "a normal answer must not be flagged");

assert.equal(looksRepetitive("короткий ответ"), false);
assert.equal(looksRepetitive(""), false);
// Duplicate short lines are ignored (headings, bullets, separators).
const withHeadings = ["Заголовок", "Заголовок", "Заголовок", "Заголовок", "Заголовок", "Заголовок", "Заголовок"].join("\n");
assert.equal(looksRepetitive(withHeadings), false, "short repeated lines are not a loop");

// An explicit larger generation limit is not lowered.
const generous = applyLocalRequestDefaults(
  {
    chat_template_kwargs: { enable_thinking: true },
    thinking_budget_tokens: 1024,
    max_tokens: 12000,
  },
  "http://127.0.0.1:8093",
  "llamacpp",
);
assert.equal(generous.max_tokens, 12000);

// Without thinking nothing is raised.
const noThinking = applyLocalRequestDefaults(
  { chat_template_kwargs: { enable_thinking: false }, thinking_budget_tokens: 0 },
  "http://127.0.0.1:8093",
  "llamacpp",
);
assert.equal(noThinking.max_tokens, 2048);

// --------------------------------------------- cloud endpoints stay untouched
const cloud = applyLocalRequestDefaults(
  { temperature: 0.7, reasoning_effort: "medium" },
  "https://api.deepseek.com",
  "deepseek",
);
assert.deepEqual(cloud, { temperature: 0.7, reasoning_effort: "medium" });

// ------------------------------------------- empty parameters get local defaults
const empty = applyLocalRequestDefaults(undefined, "http://127.0.0.1:8083", "gateway");
assert.equal(empty.temperature, KIBBORG_SAMPLING_DEFAULTS.temperature);
assert.equal(empty.max_tokens, KIBBORG_SAMPLING_DEFAULTS.max_tokens);
assert.equal(empty.top_k, KIBBORG_SAMPLING_DEFAULTS.top_k);
assert.deepEqual(applyLocalRequestDefaults(undefined, "https://api.openai.com", "none"), {});

console.log("request_defaults tests passed");
