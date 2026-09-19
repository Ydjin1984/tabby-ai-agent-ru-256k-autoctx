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

export interface ModelPreset {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  contextWindowTokens: number;
  reasoningStyle: ReasoningStyle;
  requiresToken: boolean;
  hint: string;
}

/** Id of the "type the endpoint and model yourself" pseudo-preset. */
export const CUSTOM_PRESET_ID = "custom";

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

export const MODEL_PRESETS: ReadonlyArray<ModelPreset> = [
  {
    id: "kibborg",
    label: "Kibborg_Flash_v5.7 — шлюз движка (127.0.0.1:8083)",
    endpoint: "http://127.0.0.1:8083",
    model: "Kibborg_Flash_v5.7",
    contextWindowTokens: 262144,
    reasoningStyle: "gateway",
    requiresToken: false,
    hint:
      "Публичный вход движка Kibborg: сам поднимает помощников и инструменты, " +
      "API-ключ не нужен. Уровень размышления шлюз не пробрасывает — для " +
      "рассуждений выберите «kibborg-direct».",
  },
  {
    id: "kibborg-direct",
    label: "Kibborg_Flash_v5.7 — прямой мозг (127.0.0.1:8093)",
    endpoint: "http://127.0.0.1:8093",
    model: "Kibborg_Flash_v5.7",
    contextWindowTokens: 262144,
    reasoningStyle: "llamacpp",
    requiresToken: false,
    hint:
      "Напрямую llama-server мозга (Ternary Bonsai 2 27B, окно 256K): живой " +
      "поток токенов, работают зрение и «Размышления». Помощники движка при " +
      "этом не задействуются — их зовёт только шлюз 8083.",
  },
  {
    id: "kibborg-worker-smart",
    label: "Kibborg_Worker_smart — помощник (127.0.0.1:8086)",
    endpoint: "http://127.0.0.1:8086",
    model: "Kibborg_Worker_smart",
    contextWindowTokens: 40960,
    reasoningStyle: "llamacpp",
    requiresToken: false,
    hint:
      "Помощник Qwen3-4B на второй карте: разбор логов, кода, длинных текстов " +
      "(окно 40K). Умеет вызов инструментов.",
  },
  {
    id: "kibborg-worker-fast",
    label: "Kibborg_Worker_fast — помощник (127.0.0.1:8084)",
    endpoint: "http://127.0.0.1:8084",
    model: "Kibborg_Worker_fast",
    contextWindowTokens: 32768,
    reasoningStyle: "llamacpp",
    requiresToken: false,
    hint:
      "Быстрый помощник Qwen3-1.7B: классификация, извлечение, черновик JSON " +
      "(окно 32K). Умеет вызов инструментов.",
  },
  {
    id: "deepseek-flash",
    label: "DeepSeek Flash — deepseek-flash (облако)",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-flash",
    contextWindowTokens: 1000000,
    reasoningStyle: "deepseek",
    requiresToken: true,
    hint: "Облако DeepSeek: нужен API-ключ sk-… (platform.deepseek.com) в поле Bearer token.",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro — deepseek-v4-pro (облако)",
    endpoint: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    contextWindowTokens: 1000000,
    reasoningStyle: "deepseek",
    requiresToken: true,
    hint: "Самая сильная модель DeepSeek: нужен API-ключ sk-… в поле Bearer token.",
  },
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

export function findModelPreset(
  id: string | null | undefined,
): ModelPreset | undefined {
  if (!id) {
    return undefined;
  }
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

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
  presetId?: string | null,
): ReasoningStyle {
  const preset = findModelPreset(presetId);
  if (preset) {
    return preset.reasoningStyle;
  }

  const haystack = `${endpoint} ${model}`.toLowerCase();
  if (haystack.includes("deepseek")) {
    return "deepseek";
  }
  // The engine gateway occupies 8083 and swallows reasoning switches; the brain
  // (8093) and the workers (8084-8086) are plain llama-server and honour them.
  if (haystack.includes("8083")) {
    return "gateway";
  }
  if (
    haystack.includes("8093") ||
    haystack.includes("8084") ||
    haystack.includes("8085") ||
    haystack.includes("8086") ||
    haystack.includes("llama") ||
    haystack.includes("kibborg")
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
      return "chat_template_kwargs.enable_thinking = false — размышления выключены. Рекомендуемый режим для локального мозга.";
    }
    return (
      `enable_thinking = true, thinking_budget_tokens = ${LLAMACPP_THINKING_BUDGETS[effort]} — ` +
      "размышления работают только на прямом мозге (8093) и помощниках (8084/8086), через шлюз 8083 " +
      "не пробрасываются. Замеры на одной и той же задаче: без размышлений 3 с и верная команда, " +
      `с «${effort}» — ${effort === "low" ? "14" : "23"}+ с, ответ не точнее. ` +
      "Плагин поднимет max_tokens до бюджета + 4096 и повторит запрос без размышлений, если ответ уйдёт в повтор."
    );
  }
  if (style === "gateway") {
    return (
      "Ничего не отправляется: шлюз движка Kibborg (8083) не пробрасывает настройки " +
      "размышления в мозг (в движке LLAMA_REASONING=off, включение thinking ломает " +
      "JSON диспетчера). Чтобы размышления работали — выберите «kibborg-direct» (8093) " +
      "или помощника (8084/8086)."
    );
  }
  return "Для этой модели уровень размышления не передаётся.";
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
