/**
 * Procedural memory — "how to do it right here", plus the negative memory that
 * records what has already been proven useless.
 */

import { MemoryDatabase } from "./store";
import { EnvironmentSnapshot, MemoryEntry, RankedMemory } from "./types";
import { ensureEmbedding, mergeIntoDatabase } from "./entry";
import { scoreMemory } from "./ranker";
import { bumpConfidence, clamp01, confidenceFromCounts } from "./scoring";
import { commandMatchesAction, embedText } from "./text";

export class ProceduralMemory {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  list(): MemoryEntry[] {
    return this.db.byType("procedure");
  }

  listAvoidRules(): MemoryEntry[] {
    return this.db.byType("avoid");
  }

  findApplicable(
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

  findAvoidRules(
    text: string,
    environment: EnvironmentSnapshot,
    now = Date.now(),
    limit = 3,
  ): RankedMemory[] {
    const embedding = embedText(text);
    return this.listAvoidRules()
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

  /**
   * Reinforce every procedure whose action matches the executed command. This
   * is the feedback loop that raises confidence for solutions that keep working
   * and retires those that keep failing.
   */
  reinforceCommand(command: string, success: boolean, now = Date.now()): MemoryEntry[] {
    const touched: MemoryEntry[] = [];
    for (const entry of this.list()) {
      if (!entry.action || !commandMatchesAction(command, entry.action)) {
        continue;
      }
      const successCount = entry.successCount + (success ? 1 : 0);
      const failureCount = entry.failureCount + (success ? 0 : 1);
      const updated: MemoryEntry = {
        ...entry,
        successCount,
        failureCount,
        confidence: success
          ? Math.max(bumpConfidence(entry.confidence, true), entry.confidence)
          : Math.min(bumpConfidence(entry.confidence, false), confidenceFromCounts(successCount, failureCount)),
        lastUsedAt: now,
        updatedAt: now,
      };
      this.db.upsert(updated);
      touched.push(updated);
    }
    return touched;
  }

  /** Apply a direct confidence bump to one procedure. */
  reinforceById(id: string, success: boolean, now = Date.now()): MemoryEntry | null {
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
      confidence: bumpConfidence(entry.confidence, success),
      lastUsedAt: now,
      updatedAt: now,
      score: clamp01(entry.score),
    };
    this.db.upsert(updated);
    return updated;
  }
}
