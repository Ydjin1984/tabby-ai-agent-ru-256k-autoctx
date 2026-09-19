/**
 * Request-parameter policy for the local Kibborg stack.
 *
 * The panel sends user-provided request parameters verbatim (`extraParameters`)
 * and, historically, nothing else. For the local brain that is dangerous:
 *
 * - `temperature` defaults to 1.0 on the llama-server and no repetition
 *   penalties are applied, so the ternary-quantised brain starts looping;
 * - `max_tokens` defaults to -1, so a looping generation runs until the context
 *   is exhausted — the user sees an endless wall of repeated text;
 * - `chat_template_kwargs.enable_thinking` with `thinking_budget_tokens: 0`
 *   turns on unlimited reasoning on a server that was started with
 *   `--reasoning off`. The model then "thinks" in a loop and never emits an
 *   answer (verified: `finish_reason=length`, content empty, reasoning > 3k
 *   characters). Through the engine gateway (8083) those switches are not even
 *   forwarded, so enabling them in the UI is a silent no-op / a trap.
 *
 * This module owns the corrections and is deliberately free of UI and Angular
 * so it can be unit-tested: it sanitises reasoning switches and fills in the
 * sampling parameters the Kibborg engine itself uses (see `settings.ini`).
 */

/** Ports of the local Kibborg stack (brain 8093, gateway 8083, workers 8084-8086, embeddings 8082). */
export const KIBBORG_PORTS: ReadonlySet<string> = new Set([
  "8082",
  "8083",
  "8084",
  "8085",
  "8086",
  "8090",
  "8093",
]);

/**
 * Sampling parameters the engine applies to its own requests. A ternary
 * quantised model (Bonsai 2 27B, ~1.7 bit/weight) needs the repetition and
 * presence penalties to avoid loops.
 */
export const KIBBORG_SAMPLING_DEFAULTS: Record<string, number> = {
  temperature: 0.5,
  top_p: 0.8,
  top_k: 20,
  presence_penalty: 1.5,
  repeat_penalty: 1.05,
  frequency_penalty: 0.2,
  /** Matches `LLM_MAX_TOKENS` in engine-go/settings.ini. */
  max_tokens: 2048,
};

/** Keys that make the model "think"; they must not survive a gateway hop. */
const REASONING_KEYS = [
  "reasoning_effort",
  "chat_template_kwargs",
  "thinking_budget_tokens",
  "reasoning_budget_tokens",
  "enable_thinking",
];

/** True when the endpoint points at this machine's Kibborg stack. */
export function isKibborgEndpoint(endpoint: string): boolean {
  const value = (endpoint ?? "").toLowerCase();
  if (!value) {
    return false;
  }
  if (value.includes("kibborg")) {
    return true;
  }
  const ports = value.match(/:(\d{4,5})\b/g) ?? [];
  return ports.some((match) => KIBBORG_PORTS.has(match.slice(1)));
}

/** Remove every reasoning switch from a parameters object (returns a copy). */
export function stripReasoningParameters(
  base: Record<string, any> | undefined,
): Record<string, any> {
  const result: Record<string, any> = { ...(base ?? {}) };
  for (const key of REASONING_KEYS) {
    delete result[key];
  }
  return result;
}

/**
 * A budget of 0 (or a negative value) means "no limit" on llama.cpp, which is
 * how the panel ended up streaming an endless reasoning loop. Unlimited
 * thinking is never what the user wants here, so the key is dropped: the model
 * then answers directly.
 */
function dropUnlimitedBudget(params: Record<string, any>): void {
  for (const key of ["thinking_budget_tokens", "reasoning_budget_tokens"]) {
    const value = params[key];
    if (typeof value === "number" && value <= 0) {
      delete params[key];
    }
  }
}

/**
 * Reserve kept for the actual answer when reasoning is enabled.
 *
 * Measurements on the local brain (Bonsai 2 27B, long planning task):
 * - with `thinking_budget_tokens: 2048` and `max_tokens: 2048` the whole limit
 *   went into reasoning and the answer came back EMPTY (`finish_reason=length`);
 * - with `max_tokens: 4096` the answer appeared, but reasoning still consumed
 *   ~2900 tokens and the turn was cut off again;
 * - the effective reasoning does not strictly follow the requested budget, so
 *   the reserve has to be generous: the limit must cover the budget plus a full
 *   answer's worth of tokens.
 */
export const THINKING_ANSWER_RESERVE_TOKENS = 4096;

/**
 * Upper bound for a thinking budget on the local brain.
 *
 * The "max" level asks for 16384 tokens of reasoning, which on this model turns
 * into minutes of generation and a runaway answer (measured: 198 s, 15k
 * characters, still cut off by the limit). Capping keeps the panel usable.
 */
export const LOCAL_THINKING_BUDGET_LIMIT = 4096;

/**
 * Cheap heuristic: does the text loop?
 *
 * A looping generation repeats the same non-trivial lines. Used to decide that a
 * truncated answer is garbage rather than a normal, merely long answer.
 */
export function looksRepetitive(text: string, minLineLength = 25): boolean {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= minLineLength);
  if (lines.length < 6) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let repeated = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      repeated += count;
    }
  }
  return repeated / lines.length > 0.2;
}

/**
 * Make sure `max_tokens` covers the thinking budget. Only raises the limit — an
 * explicitly larger user value is kept.
 */
function ensureThinkingBudget(params: Record<string, any>, device: boolean): void {
  const enabled = params.chat_template_kwargs?.enable_thinking === true;
  if (!enabled) {
    return;
  }
  let budget = Number(params.thinking_budget_tokens ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) {
    return;
  }
  if (device && budget > LOCAL_THINKING_BUDGET_LIMIT) {
    budget = LOCAL_THINKING_BUDGET_LIMIT;
    params.thinking_budget_tokens = budget;
  }
  const required = budget + THINKING_ANSWER_RESERVE_TOKENS;
  const current = Number(params.max_tokens ?? 0);
  if (!Number.isFinite(current) || current < required) {
    params.max_tokens = required;
  }
}

/**
 * Apply the local policy to the final request parameters.
 *
 * @param base     parameters the user typed in settings
 * @param endpoint the chat endpoint the request will go to
 * @param style    reasoning dialect resolved for endpoint + model + preset
 */
export function applyLocalRequestDefaults(
  base: Record<string, any> | undefined,
  endpoint: string,
  style: string,
): Record<string, any> {
  const device = isKibborgEndpoint(endpoint);

  // The engine gateway does not forward reasoning switches to the brain
  // (`LLAMA_REASONING=off`), and a request that carries its own tools is proxied
  // to the brain as-is — where enabling thinking produces an empty answer. Drop
  // them so the JSON box cannot silently break the local brain.
  let result =
    style === "gateway" ? stripReasoningParameters(base) : { ...(base ?? {}) };

  dropUnlimitedBudget(result);

  if (device) {
    for (const [key, value] of Object.entries(KIBBORG_SAMPLING_DEFAULTS)) {
      if (result[key] === undefined || result[key] === null) {
        result[key] = value;
      }
    }
  }

  // Thinking works on the direct brain, but only with room left for the answer.
  ensureThinkingBudget(result, device);

  return result;
}
