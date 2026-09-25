/**
 * Model presets and reasoning-effort mapping for the AI agent settings.
 *
 * The plugin talks to any OpenAI-compatible endpoint, so a "model choice" is
 * really a triple: base URL, model id, and how that provider wants the
 * thinking/reasoning budget expressed. This module owns that knowledge so the
 * settings page only has to pick an id and the chat session only has to merge
 * the resulting request parameters.
 */

export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

/**
 * How a provider expresses the reasoning budget:
 * - `deepseek` — the top-level `reasoning_effort` field.
 * - `llamacpp` — llama.cpp chat-template switches (`chat_template_kwargs`
 *   plus `thinking_budget_tokens`); this is the real brain and the workers.
 * - `gateway` — the Kibborg gateway (port 8083). It accepts the request but does
 *   NOT forward reasoning switches to the brain (`LLAMA_REASONING=off` on the
 *   engine side, and enabling thinking breaks the engine's dispatcher JSON), so
 *   sending them would silently do nothing. Nothing is sent, and the settings
 *   page says so instead of promising an effect that never happens.
 * - `none` — provider has no reasoning controls; effort is ignored.
 */
export type ReasoningStyle = "deepseek" | "llamacpp" | "gateway" | "none";

/**
 * Reasoning levels offered in settings. `off` disables thinking where the
 * provider allows it; every other level is mapped per provider below.
 */
export const REASONING_EFFORTS: ReadonlyArray<{
  id: ReasoningEffort;
  label: string;
}> = [
  { id: "off", label: "Выключено (off)" },
  { id: "low", label: "Низкий (low)" },
  { id: "medium", label: "Средний (medium)" },
  { id: "high", label: "Высокий (high)" },
  { id: "max", label: "Максимальный (max)" },
];

/** Per-level thinking budget (tokens) for llama.cpp-backed models. */
const LLAMACPP_THINKING_BUDGETS: Record<
  Exclude<ReasoningEffort, "off">,
  number
> = {
  low: 1024,
  medium: 2048,
  high: 4096,
  max: 16384,
};

/** Per-level wire value of `reasoning_effort` for the DeepSeek API. */
const DEEPSEEK_EFFORT_VALUES: Record<ReasoningEffort, string> = {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort.id === value);
}

/**
 * Which reasoning dialect applies to the current endpoint/model pair. The
 * explicit preset wins; a hand-typed endpoint falls back to sniffing the URL
 * and the model id, so the manual path keeps working.
 */
export function resolveReasoningStyle(
  endpoint: string,
  model: string,
): ReasoningStyle {
  const haystack = `${endpoint} ${model}`.toLowerCase();
  if (haystack.includes("deepseek")) {
    return "deepseek";
  }
  // Every Kibborg endpoint (local 8083 gateway, LAN, remote `/mcp/`, direct brain
  // 8093, workers 8084-8086) speaks the llama.cpp dialect. Sending an explicit
  // `enable_thinking` is the safe choice: an endpoint that ignores it behaves as
  // before, while the remote gateway honours it (thinking off cut 127 s → 10 s).
  if (
    haystack.includes("8083") ||
    haystack.includes("8093") ||
    haystack.includes("8084") ||
    haystack.includes("8085") ||
    haystack.includes("8086") ||
    haystack.includes("/mcp/") ||
    haystack.includes("kibborg") ||
    haystack.includes("kiborg") ||
    haystack.includes("llama")
  ) {
    return "llamacpp";
  }
  return "none";
}

/**
 * Request-body fragment that expresses the chosen reasoning level for the
 * given dialect. `off` still returns a fragment when the provider needs an
 * explicit "do not think" switch.
 */
export function buildReasoningParameters(
  style: ReasoningStyle,
  effort: ReasoningEffort,
): Record<string, any> {
  if (style === "deepseek") {
    return { reasoning_effort: DEEPSEEK_EFFORT_VALUES[effort] };
  }

  if (style === "llamacpp") {
    if (effort === "off") {
      return { chat_template_kwargs: { enable_thinking: false } };
    }
    return {
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: LLAMACPP_THINKING_BUDGETS[effort],
    };
  }

  if (style === "gateway") {
    // Nothing is sent: the gateway does not forward reasoning switches to the
    // brain, so a fragment here would only create a false impression in the UI.
    return {};
  }

  return {};
}

/**
 * Merge the user's free-form request parameters with the reasoning fragment.
 * The reasoning level is an explicit choice in settings, so it wins over a
 * stale `reasoning_effort`/`chat_template_kwargs` left in the JSON box, while
 * unrelated keys of the JSON box survive.
 */
export function mergeReasoningParameters(
  base: Record<string, any> | undefined,
  style: ReasoningStyle,
  effort: ReasoningEffort,
): Record<string, any> {
  const merged: Record<string, any> = { ...(base ?? {}) };
  const reasoning = buildReasoningParameters(style, effort);

  for (const [key, value] of Object.entries(reasoning)) {
    if (
      key === "chat_template_kwargs" &&
      isPlainObject(merged[key]) &&
      isPlainObject(value)
    ) {
      merged[key] = { ...merged[key], ...value };
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

/** Human-readable summary of what the current choice sends. */
export function describeReasoning(
  style: ReasoningStyle,
  effort: ReasoningEffort,
): string {
  if (style === "deepseek") {
    const value = DEEPSEEK_EFFORT_VALUES[effort];
    return effort === "off"
      ? 'reasoning_effort: "none" — модель отвечает без цепочки рассуждений.'
      : `reasoning_effort: "${value}" — DeepSeek сам распределит бюджет рассуждений.`;
  }
  if (style === "llamacpp") {
    if (effort === "off") {
      return "enable_thinking = false — размышления выключены. Рекомендуемый режим: ответ в разы быстрее.";
    }
    return (
      `enable_thinking = true, thinking_budget_tokens = ${LLAMACPP_THINKING_BUDGETS[effort]}. ` +
      "На локальном мозге размышления заметно замедляют ответ и редко повышают точность — держите «Выключено», " +
      "если не нужна особая глубина."
    );
  }
  return "Для этой модели уровень размышления не передаётся.";
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
