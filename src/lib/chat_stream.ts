/**
 * Разбор потока chat-completions и подготовка сообщений к запросу.
 *
 * Вынесено из сессии, чтобы пограничные случаи (обрезка SSE, поля reasoning,
 * потолок вывода инструментов) проверялись без сети и без Angular.
 */

export interface StreamToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamAccumulator {
  content: string;
  reasoning: string;
  finishReason: string | null;
  promptTokens: number | null;
  toolCalls: Record<string, StreamToolCall>;
}

/** Сколько символов вывода инструмента уходит в следующий запрос модели. */
export const TOOL_RESULT_CHAR_LIMIT = 12_000;

const TOOL_RESULT_MARKER =
  "\n… [середина вывода опущена, оставлены начало и конец] …\n";

export function createStreamAccumulator(): StreamAccumulator {
  return {
    content: "",
    reasoning: "",
    finishReason: null,
    promptTokens: null,
    toolCalls: {},
  };
}

/**
 * Забирает из буфера только целые строки SSE. Хвост без перевода строки
 * остаётся до следующего чанка: иначе JSON режется посередине и имя
 * инструмента теряется.
 */
export function takeCompleteSseLines(
  buffer: string,
  done: boolean,
): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  if (done) {
    return { lines: parts, rest: "" };
  }
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

function reasoningText(delta: any): string {
  if (!delta || typeof delta !== "object") {
    return "";
  }
  if (typeof delta.reasoning_content === "string") {
    return delta.reasoning_content;
  }
  if (typeof delta.reasoning === "string") {
    return delta.reasoning;
  }
  if (typeof delta.reasoning?.content === "string") {
    return delta.reasoning.content;
  }
  return "";
}

/**
 * Применяет один JSON-чанк OpenAI-совместимого потока.
 * Дельта читается до finish_reason: часть серверов кладёт последний токен
 * и причину завершения в один объект, и ранний выход терял этот токен.
 */
export function applyChatCompletionChunk(
  state: StreamAccumulator,
  parsed: any,
): void {
  const usage = parsed?.usage;
  if (
    usage &&
    typeof usage.prompt_tokens === "number" &&
    Number.isFinite(usage.prompt_tokens)
  ) {
    state.promptTokens = usage.prompt_tokens;
  }

  const choice = parsed?.choices?.[0];
  if (!choice) {
    return;
  }

  const delta = choice.delta;
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const key =
        tc.index !== undefined && tc.index !== null
          ? String(tc.index)
          : `call:${tc.id ?? Object.keys(state.toolCalls).length}`;
      if (!state.toolCalls[key]) {
        state.toolCalls[key] = {
          id: tc.id ?? "",
          type: "function",
          function: { name: tc.function?.name ?? "", arguments: "" },
        };
      } else {
        if (!state.toolCalls[key].id && tc.id) {
          state.toolCalls[key].id = tc.id;
        }
        const deltaName = tc.function?.name;
        if (!state.toolCalls[key].function.name && deltaName) {
          state.toolCalls[key].function.name = deltaName;
        }
      }
      if (tc.function?.arguments) {
        state.toolCalls[key].function.arguments += tc.function.arguments;
      }
    }
  }

  const reasoning = reasoningText(delta);
  if (reasoning) {
    state.reasoning += reasoning;
  }
  if (typeof delta?.content === "string" && delta.content) {
    state.content += delta.content;
  }

  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason;
  }
}

/**
 * Оставляет начало и конец длинного вывода. В историю панели текст не режется —
 * режется только копия, которая уходит модели.
 */
export function capToolResult(
  content: string,
  limit = TOOL_RESULT_CHAR_LIMIT,
): string {
  if (!content || content.length <= limit) {
    return content;
  }
  const headLen = Math.min(1_500, Math.floor(limit * 0.15));
  const tailLen = limit - headLen - TOOL_RESULT_MARKER.length;
  if (tailLen < 1) {
    return content.slice(0, limit);
  }
  return (
    content.slice(0, headLen) +
    TOOL_RESULT_MARKER +
    content.slice(content.length - tailLen)
  );
}

export interface ModelMessage {
  role: string;
  content: string | null | any[];
  tool_call_id?: string | null;
  tool_calls?: any[] | null;
}

/**
 * Сообщения, которые реально уходят в запрос: рассуждения остаются в ленте,
 * но не в контексте (шаблоны чата их не принимают), длинный вывод инструментов
 * обрезается.
 */
/** После стольких вызовов инструментов за ход панель показывает предупреждение. */
export const TURN_TOOL_WARNING = 12;
/** Дольше этого ход останавливается, даже если модель ещё хочет инструменты. */
export const TURN_DEADLINE_MS = 20 * 60 * 1000;
/** Доля окна, с которой ход сам просит сжатие, не дожидаясь конца ответа. */
export const TURN_COMPACT_USAGE = 0.85;
/** Сжатие, освободившее меньше этой доли, считается бесполезным. */
export const TURN_COMPACT_MIN_GAIN = 0.02;
export const TURN_MAX_COMPACTIONS = 2;

export interface TurnGuardInput {
  elapsedMs: number;
  toolCalls: number;
  usageRatio: number;
  compactions: number;
  /** Доля токенов, которую освободило последнее сжатие этого хода. */
  lastGain: number | null;
}

export interface TurnGuardDecision {
  warning: string | null;
  stop: string | null;
  compact: boolean;
}

/**
 * Мягкий предохранитель одного хода: предупреждение о длинной серии инструментов,
 * останов по времени и останов, если сжатие больше не освобождает окно.
 */
export function assessTurnGuard(input: TurnGuardInput): TurnGuardDecision {
  const warning =
    input.toolCalls >= TURN_TOOL_WARNING
      ? `Уже ${input.toolCalls} вызовов инструментов за этот ход. Если результат есть — отвечай пользователю, не продолжай поиск.`
      : null;

  if (input.elapsedMs >= TURN_DEADLINE_MS) {
    return {
      warning,
      stop: "Ход остановлен: он длится дольше 20 минут. Сузьте задачу или отправьте новый запрос.",
      compact: false,
    };
  }

  const crowded = input.usageRatio >= TURN_COMPACT_USAGE;
  if (
    crowded &&
    input.lastGain !== null &&
    input.lastGain < TURN_COMPACT_MIN_GAIN
  ) {
    return {
      warning,
      stop: "Сжатие почти ничего не освободило — останавливаю ход, чтобы не забить окно контекста.",
      compact: false,
    };
  }
  if (crowded && input.compactions >= TURN_MAX_COMPACTIONS) {
    return {
      warning,
      stop: "Контекст уже дважды сжимался в этом ходе и снова заполнен — останавливаю ход.",
      compact: false,
    };
  }
  if (crowded) {
    return { warning, stop: null, compact: true };
  }
  return { warning, stop: null, compact: false };
}

export function prepareModelMessages<T extends ModelMessage>(history: T[]): T[] {
  const prepared: T[] = [];
  for (const item of history) {
    if (item.role === "reasoning") {
      continue;
    }
    if (item.role === "tool" && typeof item.content === "string") {
      const capped = capToolResult(item.content);
      prepared.push(
        capped === item.content ? item : ({ ...item, content: capped } as T),
      );
      continue;
    }
    prepared.push(item);
  }
  return prepared;
}
