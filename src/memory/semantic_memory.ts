/**
 * Semantic memory — durable facts about the environment/project and the
 * "lessons learned" distilled from past episodes.
 */

import { MemoryDatabase } from "./store";
import { EnvironmentSnapshot, MemoryEntry, RankedMemory } from "./types";
import { ensureEmbedding, mergeIntoDatabase } from "./entry";
import { scoreMemory } from "./ranker";
import { embedText } from "./text";

export class SemanticMemory {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  listFacts(): MemoryEntry[] {
    return this.db.byType("fact");
  }

  listLessons(): MemoryEntry[] {
    return this.db.byType("lesson");
  }

  findFacts(
    text: string,
    environment: EnvironmentSnapshot,
    now = Date.now(),
    limit = 5,
  ): RankedMemory[] {
    return this.rank(this.listFacts(), text, environment, now, limit);
  }

  findLessons(
    text: string,
    environment: EnvironmentSnapshot,
    now = Date.now(),
    limit = 4,
  ): RankedMemory[] {
    return this.rank(this.listLessons(), text, environment, now, limit);
  }

  record(draft: MemoryEntry, now = Date.now()): MemoryEntry {
    return mergeIntoDatabase(this.db, draft, now);
  }

  private rank(
    entries: MemoryEntry[],
    text: string,
    environment: EnvironmentSnapshot,
    now: number,
    limit: number,
  ): RankedMemory[] {
    const embedding = embedText(text);
    return entries
      .map((entry) =>
        scoreMemory(ensureEmbedding(entry), { text, embedding, environment, now, limit }),
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, limit));
  }
}
