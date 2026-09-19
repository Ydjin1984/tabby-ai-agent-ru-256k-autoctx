export interface CheckpointRequestBody {
  model: string;
  messages: Array<{
    role: "user";
    content: string;
  }>;
  stream: false;
  max_tokens: 1;
}

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim();
  normalized = normalized.replace(/\/v1\/chat\/completions\/?$/i, "");
  normalized = normalized.replace(/\/v1\/?$/i, "");
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeOpenAIBaseUrl(baseUrl)}/v1/chat/completions`;
}

export function buildCheckpointRequestBody(
  model = "default",
): CheckpointRequestBody {
  return {
    model,
    messages: [
      {
        role: "user",
        content: "Validate this endpoint.",
      },
    ],
    stream: false,
    max_tokens: 1,
  };
}

/** URL of llama.cpp's server properties endpoint (used for context detection). */
export function buildPropsUrl(baseUrl: string): string {
  return `${normalizeOpenAIBaseUrl(baseUrl)}/props`;
}

/**
 * Ask a llama.cpp-compatible endpoint for its real context window via /props.
 * Returns `n_ctx` when the server reports it, otherwise `null` (so callers keep
 * the configured fallback for providers that have no /props endpoint).
 */
export async function fetchContextWindow(
  baseUrl: string,
): Promise<number | null> {
  if (!baseUrl) {
    return null;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(buildPropsUrl(baseUrl), {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const nCtx = Number(
      data?.default_generation_settings?.n_ctx ?? data?.n_ctx,
    );
    return Number.isFinite(nCtx) && nCtx > 0 ? nCtx : null;
  } catch {
    return null;
  }
}
