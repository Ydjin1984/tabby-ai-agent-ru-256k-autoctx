import { Injectable } from "@angular/core";
import { ConfigService } from "tabby-core";
import * as os from "os";
import * as path from "path";
import {
  EmbeddingProvider,
  JsonFileStore,
  MemoryManager,
  createEmbeddingProvider,
} from "../memory";

/**
 * Angular wrapper around the framework-free [[MemoryManager]].
 *
 * A single manager is shared by every AI Agent panel so experience learned in
 * one terminal is available in all of them. Memories are kept environment-scoped,
 * so a Windows/PowerShell fix never leaks into a Linux/bash session.
 */
@Injectable()
export class AIAgentMemoryService {
  private managerInstance: MemoryManager | null = null;

  constructor(private config: ConfigService) {}

  get manager(): MemoryManager {
    if (!this.managerInstance) {
      this.managerInstance = new MemoryManager({
        store: new JsonFileStore(this.memoryFilePath()),
        enabled: this.isMemoryEnabled(),
        retrievalLimit: this.getNumber("memoryRetrievalLimit", 6),
        contextTokenBudget: this.getNumber("memoryContextTokens", 1200),
        embeddingProvider: this.buildEmbeddingProvider(),
        onPersistError: () => undefined,
      });
    }
    return this.managerInstance;
  }

  /** Re-read the toggles that can change without reloading the extension. */
  applyConfig(): void {
    const manager = this.manager;
    manager.setEnabled(this.isMemoryEnabled());
    manager.setRetrievalLimit(this.getNumber("memoryRetrievalLimit", 6));
    manager.setContextTokenBudget(this.getNumber("memoryContextTokens", 1200));
    manager.setEmbeddingProvider(this.buildEmbeddingProvider());
  }

  /** Force a full re-embedding pass (used by the Inspector). */
  async reindex(): Promise<number> {
    return this.manager.reindexEmbeddings();
  }

  memoryFilePath(): string {
    try {
      return path.join(os.homedir(), ".tabby-ai-agent", "memory.json");
    } catch {
      return path.join(".", ".tabby-ai-agent", "memory.json");
    }
  }

  /**
   * Embedding backend for the memory layer.
   *
   * The chat endpoint is deliberately NOT used as a fallback: the Kibborg chat
   * gateway (8083) answers `501 Not Implemented` on `/v1/embeddings`, so a
   * "fall back to llmEndpoint" rule silently broke semantic retrieval. When no
   * endpoint is configured we point at the dedicated embedding server (8082) and
   * let [[ResilientEmbeddingProvider]] degrade to offline vectors if it is down.
   */
  private buildEmbeddingProvider(): EmbeddingProvider {
    const aiAgent = this.config.store.aiAgent;
    const endpoint = aiAgent?.memoryEmbeddingEndpoint?.trim?.() ?? "";
    return createEmbeddingProvider({
      provider: aiAgent?.memoryEmbeddingProvider ?? "auto",
      endpoint,
      apiToken: aiAgent?.apiToken ?? "",
      model: aiAgent?.memoryEmbeddingModel ?? "",
      dimensions: Number(aiAgent?.memoryEmbeddingDimensions) || 0,
    });
  }

  private isMemoryEnabled(): boolean {
    return this.config.store.aiAgent?.memoryEnabled !== false;
  }

  private getNumber(key: string, fallback: number): number {
    const value = Number(this.config.store.aiAgent?.[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
