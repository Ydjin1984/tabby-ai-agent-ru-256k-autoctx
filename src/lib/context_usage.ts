/**
 * Context usage helpers: token estimation and compaction policy.
 *
 * The plugin talks to OpenAI-compatible endpoints. Many local servers do not
 * report `usage` on streaming responses, so we keep a lightweight heuristic
 * token counter to drive the context meter and the auto-compaction trigger.
 */

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
export const AUTO_COMPACT_THRESHOLD = 0.7;

/** Approximate token count for a piece of text (chars-based heuristic). */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else nonAscii++;
  }
  // Rough tokenizer: ~4 ASCII chars per token, ~1.6 non-ASCII chars per token.
  const tokens = ascii / 4 + nonAscii / 1.6;
  return Math.ceil(tokens) || 0;
}

export interface TokenCountable {
  role: string;
  content: string | null | any[];
  tool_call_id?: string | null;
  tool_calls?: any[] | null;
}

/**
 * Estimate how many tokens the given conversation history occupies,
 * including the JSON envelope overhead of each message.
 */
export function estimateHistoryTokens(history: TokenCountable[]): number {
  if (!Array.isArray(history) || history.length === 0) return 0;
  let total = 0;
  for (const item of history) {
    try {
      const serialized = JSON.stringify(item) ?? "";
      total += estimateTokenCount(serialized);
      // JSON field names / structural overhead is not free for the model.
      total += 4;
    } catch {
      total += 16;
    }
  }
  return total;
}

/**
 * Estimate tokens for the tool schema definitions that are sent on every
 * request. This is part of the context window too.
 */
export function estimateToolSchemaTokens(toolSchema: any[]): number {
  if (!Array.isArray(toolSchema) || toolSchema.length === 0) return 0;
  try {
    return estimateTokenCount(JSON.stringify(toolSchema));
  } catch {
    return 64;
  }
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${k.toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Pick the tail of the history that fits within `maxTokens` tokens.
 * Used when the full history would not fit into a compaction request.
 */
export function takeTailByTokens<T extends TokenCountable>(
  history: T[],
  maxTokens: number,
): T[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  const reversed: T[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    try {
      used += estimateTokenCount(JSON.stringify(item) ?? "") + 4;
    } catch {
      used += 16;
    }
    if (used > maxTokens) break;
    reversed.push(item);
  }
  reversed.reverse();
  return reversed.length > 0 ? reversed : history.slice(-1);
}
