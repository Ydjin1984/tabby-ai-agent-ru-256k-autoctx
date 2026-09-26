import assert from "node:assert/strict";
import {
  TOOL_RESULT_CHAR_LIMIT,
  TURN_COMPACT_USAGE,
  TURN_DEADLINE_MS,
  TURN_MAX_COMPACTIONS,
  TURN_TOOL_WARNING,
  applyChatCompletionChunk,
  assessTurnGuard,
  capToolResult,
  createStreamAccumulator,
  prepareModelMessages,
  takeCompleteSseLines,
} from "../src/lib/chat_stream";

const split = takeCompleteSseLines('data: {"a":1}\ndata: {"b":', false);
assert.deepEqual(split.lines, ['data: {"a":1}']);
assert.equal(split.rest, 'data: {"b":');

const state = createStreamAccumulator();
applyChatCompletionChunk(state, {
  choices: [
    {
      delta: { content: "привет", reasoning_content: "думаю" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 42 },
});
assert.equal(state.content, "привет");
assert.equal(state.reasoning, "думаю");
assert.equal(state.finishReason, "stop");
assert.equal(state.promptTokens, 42);

const reasoningAlias = createStreamAccumulator();
applyChatCompletionChunk(reasoningAlias, {
  choices: [{ delta: { reasoning: "цепочка" }, finish_reason: null }],
});
assert.equal(reasoningAlias.reasoning, "цепочка");
assert.equal(reasoningAlias.finishReason, null);

const tools = createStreamAccumulator();
applyChatCompletionChunk(tools, {
  choices: [
    {
      delta: {
        tool_calls: [
          { index: 0, id: "call-1", function: { name: "run_shell_command", arguments: "{" } },
        ],
      },
    },
  ],
});
applyChatCompletionChunk(tools, {
  choices: [
    {
      delta: {
        tool_calls: [{ index: 0, function: { arguments: '"command":"dir"}' } }],
      },
      finish_reason: "tool_calls",
    },
  ],
});
assert.equal(tools.toolCalls["0"].function.name, "run_shell_command");
assert.equal(tools.toolCalls["0"].function.arguments, '{"command":"dir"}');
assert.equal(tools.toolCalls["0"].id, "call-1");
assert.equal(tools.finishReason, "tool_calls");

const long = "A".repeat(2_000) + "MIDDLE" + "Z".repeat(20_000);
const capped = capToolResult(long);
assert.ok(capped.length <= TOOL_RESULT_CHAR_LIMIT);
assert.ok(capped.startsWith("A"));
assert.ok(capped.endsWith("Z"));
assert.ok(capped.includes("середина вывода опущена"));
assert.equal(capToolResult("короткий"), "короткий");

const prepared = prepareModelMessages([
  { role: "system", content: "sys" },
  { role: "reasoning", content: "скрыто" },
  { role: "tool", content: long, tool_call_id: "1" },
]);
assert.equal(prepared.length, 2);
assert.equal(prepared[0].content, "sys");
assert.ok(String(prepared[1].content).length <= TOOL_RESULT_CHAR_LIMIT);
assert.equal(long.length > TOOL_RESULT_CHAR_LIMIT, true);

const quiet = assessTurnGuard({
  elapsedMs: 1000,
  toolCalls: 1,
  usageRatio: 0.2,
  compactions: 0,
  lastGain: null,
});
assert.equal(quiet.stop, null);
assert.equal(quiet.compact, false);
assert.equal(quiet.warning, null);

const noisy = assessTurnGuard({
  elapsedMs: 1000,
  toolCalls: TURN_TOOL_WARNING,
  usageRatio: 0.2,
  compactions: 0,
  lastGain: null,
});
assert.ok(noisy.warning);
assert.equal(noisy.stop, null);

const crowded = assessTurnGuard({
  elapsedMs: 1000,
  toolCalls: 2,
  usageRatio: TURN_COMPACT_USAGE,
  compactions: 0,
  lastGain: null,
});
assert.equal(crowded.compact, true);
assert.equal(crowded.stop, null);

const useless = assessTurnGuard({
  elapsedMs: 1000,
  toolCalls: 2,
  usageRatio: TURN_COMPACT_USAGE,
  compactions: 1,
  lastGain: 0.001,
});
assert.ok(useless.stop);
assert.equal(useless.compact, false);

const exhausted = assessTurnGuard({
  elapsedMs: 1000,
  toolCalls: 2,
  usageRatio: TURN_COMPACT_USAGE,
  compactions: TURN_MAX_COMPACTIONS,
  lastGain: 0.5,
});
assert.ok(exhausted.stop);

const timedOut = assessTurnGuard({
  elapsedMs: TURN_DEADLINE_MS,
  toolCalls: 1,
  usageRatio: 0.1,
  compactions: 0,
  lastGain: null,
});
assert.ok(timedOut.stop);
assert.equal(timedOut.compact, false);

console.log("chat_stream tests passed");
