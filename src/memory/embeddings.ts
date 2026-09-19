/**
 * Embedding providers.
 *
 * `embedText()` is deliberately NOT replaced by an HTTP call: retrieval talks to
 * an [[EmbeddingProvider]] so the default stays the offline hashed embedding and
 * a BGE-M3 / LM Studio / OpenAI-compatible endpoint can be plugged in later.
 *
 * Every entry stores the id and dimensions of the provider that produced its
 * vector, so switching models is detectable and old vectors can be re-indexed
 * instead of being silently compared against incompatible ones.
 */

import { EMBEDDING_DIM, embedText } from "./text";
import { normalizeOpenAIBaseUrl } from "../lib/llm_endpoint";

export const EMBEDDING_VERSION = 1;

/**
 * Default embedding backend of this machine's Kibborg stack: a dedicated
 * llama-server with `Qwen3-Embedding-0.6B` (`Kibborg_Embed_v1`, 1024 dims).
 *
 * Note the port: the chat gateway on 8083 does NOT serve `/v1/embeddings`
 * (it answers `501 Not Implemented`), so embedding requests must never fall back
 * to `llmEndpoint`.
 */
export const KIBBORG_EMBEDDING_ENDPOINT = "http://127.0.0.1:8082";
export const KIBBORG_EMBEDDING_MODEL = "Kibborg_Embed_v1";

export interface EmbeddingProvider {
  /** Stable provider identity, including model and dimensions. */
  id(): string;
  dimensions(): number;
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}

export class HashedEmbeddingProvider implements EmbeddingProvider {
  private dim: number;

  constructor(dimensions = EMBEDDING_DIM) {
    this.dim = dimensions;
  }

  id(): string {
    return `hashed-v${EMBEDDING_VERSION}`;
  }

  dimensions(): number {
    return this.dim;
  }

  async embed(text: string): Promise<number[]> {
    return embedText(text, this.dim);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedText(text, this.dim));
  }
}

export interface OpenAIEmbeddingOptions {
  endpoint: string;
  apiToken?: string;
  model: string;
  dimensions?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-compatible `/v1/embeddings` provider. Works with OpenAI, LiteLLM,
 * llama.cpp server, LM Studio, Ollama's OpenAI shim, etc.
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private apiToken: string;
  private model: string;
  private dim: number;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: OpenAIEmbeddingOptions) {
    this.baseUrl = normalizeOpenAIBaseUrl(options.endpoint);
    this.apiToken = options.apiToken?.trim() ?? "";
    this.model = options.model.trim();
    this.dim = options.dimensions && options.dimensions > 0 ? options.dimensions : 0;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  id(): string {
    return `openai:${this.model}:${this.dim || "auto"}`;
  }

  dimensions(): number {
    return this.dim;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiToken) {
        headers.Authorization = `Bearer ${this.apiToken}`;
      }
      const response = await this.fetchImpl(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({ model: this.model, input: texts }),
      });
      if (!response.ok) {
        throw new Error(`Embeddings API error: ${response.status} ${response.statusText}`);
      }
      const data: any = await response.json();
      const rows: any[] = Array.isArray(data?.data) ? data.data : [];
      const vectors = rows
        .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
        .map((row) => l2Normalize(Array.isArray(row?.embedding) ? row.embedding : []));
      if (this.dim === 0 && vectors[0]?.length) {
        this.dim = vectors[0].length;
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Keeps semantic retrieval alive when the embedding server is down.
 *
 * The primary (remote) provider is tried first; on failure the provider degrades
 * to the offline hashed vectors for a cooldown window instead of returning empty
 * ones. While degraded `id()` reports the fallback, so [[MemoryManager]] treats
 * the store as hashed-backed and re-embeds consistently instead of comparing
 * vectors of two different spaces.
 */
export class ResilientEmbeddingProvider implements EmbeddingProvider {
  private primary: EmbeddingProvider;
  private fallback: EmbeddingProvider;
  private cooldownMs: number;
  private degradedUntil = 0;
  private lastErrorMessage = "";
  private onFallback?: (error: unknown) => void;

  constructor(options: {
    primary: EmbeddingProvider;
    fallback?: EmbeddingProvider;
    cooldownMs?: number;
    onFallback?: (error: unknown) => void;
  }) {
    this.primary = options.primary;
    this.fallback = options.fallback ?? new HashedEmbeddingProvider();
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.onFallback = options.onFallback;
  }

  /** True while the primary provider is considered unavailable. */
  isDegraded(now = Date.now()): boolean {
    return now < this.degradedUntil;
  }

  /** Last failure message, for the settings page. */
  get lastError(): string {
    return this.lastErrorMessage;
  }

  id(): string {
    return this.isDegraded() ? this.fallback.id() : this.primary.id();
  }

  dimensions(): number {
    return this.isDegraded() ? this.fallback.dimensions() : this.primary.dimensions();
  }

  async embed(text: string): Promise<number[]> {
    if (!this.isDegraded()) {
      try {
        const vector = await this.primary.embed(text);
        if (vector?.length) {
          return vector;
        }
      } catch (error) {
        this.degrade(error);
      }
    }
    return this.fallback.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }
    if (!this.isDegraded()) {
      try {
        if (this.primary.embedBatch) {
          const vectors = await this.primary.embedBatch(texts);
          if (vectors.length === texts.length && vectors.every((v) => v?.length)) {
            return vectors;
          }
        } else {
          const vectors = await Promise.all(texts.map((text) => this.primary.embed(text)));
          if (vectors.every((vector) => vector?.length)) {
            return vectors;
          }
        }
      } catch (error) {
        this.degrade(error);
      }
    }
    if (this.fallback.embedBatch) {
      return this.fallback.embedBatch(texts);
    }
    return Promise.all(texts.map((text) => this.fallback.embed(text)));
  }

  private degrade(error: unknown): void {
    this.lastErrorMessage = error instanceof Error ? error.message : String(error);
    this.degradedUntil = Date.now() + this.cooldownMs;
    this.onFallback?.(error);
  }
}

export function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

/**
 * Build the provider described by the plugin settings.
 *
 * - `auto` (default): the Kibborg embedding server when an endpoint and a model
 *   are configured, with the offline provider as a live fallback.
 * - `openai`: a remote endpoint only, no fallback (explicit user choice).
 * - anything else / missing config: the offline hashed provider.
 */
export function createEmbeddingProvider(options: {
  provider: string;
  endpoint: string;
  apiToken: string;
  model: string;
  dimensions: number;
  onFallback?: (error: unknown) => void;
}): EmbeddingProvider {
  const provider = (options.provider ?? "auto").toLowerCase();
  const wantsRemote = provider === "openai" || provider === "auto";
  const endpoint = options.endpoint?.trim() || (wantsRemote ? KIBBORG_EMBEDDING_ENDPOINT : "");
  const model = options.model?.trim() || (wantsRemote ? KIBBORG_EMBEDDING_MODEL : "");

  if (wantsRemote && endpoint && model) {
    const primary = new OpenAICompatibleEmbeddingProvider({
      endpoint,
      apiToken: options.apiToken,
      model,
      dimensions: options.dimensions,
    });
    if (provider === "openai") {
      return primary;
    }
    return new ResilientEmbeddingProvider({
      primary,
      fallback: new HashedEmbeddingProvider(),
      onFallback: options.onFallback,
    });
  }

  return new HashedEmbeddingProvider();
}
