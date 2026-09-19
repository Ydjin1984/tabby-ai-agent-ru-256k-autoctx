/**
 * Episodic memory — "when this problem happened, this is what worked".
 */

import { MemoryDatabase } from "./store";
import { EnvironmentSnapshot, MemoryEntry, RankedMemory } from "./types";
import { ensureEmbedding, mergeIntoDatabase } from "./entry";
import { scoreMemory } from "./ranker";
import { confidenceFromCounts, clamp01 } from "./scoring";
import { embedText } from "./text";

export class EpisodicMemory {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  list(): MemoryEntry[] {
    return this.db.byType("episode");
  }

  findSimilar(
    text: string,
    environment: EnvironmentSnapshot,
    now = Date.now(),
    limit = 5,
  ): RankedMemory[] {
    const embedding = embedText(text);
    return this.list()
      .map((entry) =>
        scoreMemory(ensureEmbedding(entry), {
          text,
          embedding,
          environment,
          now,
          limit,
        }),
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, limit));
  }

  record(draft: MemoryEntry, now = Date.now()): MemoryEntry {
    return mergeIntoDatabase(this.db, draft, now);
  }

  reinforce(id: string, success: boolean, score: number, now = Date.now()): MemoryEntry | null {
    const entry = this.db.get(id);
    if (!entry) {
      return null;
    }
    const successCount = entry.successCount + (success ? 1 : 0);
    const failureCount = entry.failureCount + (success ? 0 : 1);
    const updated: MemoryEntry = {
      ...entry,
      successCount,
      failureCount,
      confidence: confidenceFromCounts(successCount, failureCount),
      score: Math.max(entry.score, clamp01(score)),
      lastUsedAt: now,
      updatedAt: now,
    };
    this.db.upsert(updated);
    return updated;
  }
}
