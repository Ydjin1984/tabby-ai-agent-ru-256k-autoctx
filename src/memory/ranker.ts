/**
 * Memory ranking.
 *
 * A plain nearest-neighbour lookup would let an old, textually-similar but
 * wrong memory outrank a fresh, proven one. The final score is a weighted mix
 * of semantics, environment fit, success rate, recency, usage and action match,
 * with an explicit boost for an exact error-signature hit (§ error signatures
 * are often a stronger signal than embeddings). Confidence and lifecycle status
 * scale the result.
 */

import {
  EnvironmentSnapshot,
  MemoryEntry,
  MemoryQuery,
  ProcedureStatus,
  RankedMemory,
} from "./types";
import { cosineSimilarity, lexicalSimilarity } from "./text";
import { environmentMatch } from "./environment";
import { successRate } from "./scoring";

export interface RankWeights {
  semantic: number;
  environment: number;
  success: number;
  recency: number;
  usage: number;
  actionMatch: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  semantic: 0.35,
  environment: 0.2,
  success: 0.2,
  recency: 0.1,
  usage: 0.1,
  actionMatch: 0.05,
};

export const EXACT_SIGNAL_BOOST = 0.15;
export const RECENCY_HALF_LIFE_DAYS = 30;
const USAGE_TARGET = 10;

const STATUS_BOOST: Record<ProcedureStatus, number> = {
  trusted: 1.1,
  validated: 1.05,
  candidate: 1,
  superseded: 0.15,
};

export function recencyScore(timestamp: number, now: number): number {
  if (!timestamp) {
    return 0;
  }
  const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

export function usageScore(useCount: number): number {
  const value = Math.log1p(Math.max(0, useCount));
  return Math.min(1, value / Math.log1p(USAGE_TARGET));
}

export function scoreMemory(
  entry: MemoryEntry,
  query: MemoryQuery,
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
): RankedMemory {
  const semantic =
    query.embedding?.length &&
    entry.embedding?.length &&
    query.embedding.length === entry.embedding.length &&
    // Сравниваем только векторы одного пространства: раньше проверялась лишь длина,
    // и после смены модели эмбеддингов косинус (вес 0.35) превращался в мусор.
    (!query.embeddingModel || !entry.embeddingModel || query.embeddingModel === entry.embeddingModel)
      ? cosineSimilarity(query.embedding, entry.embedding)
      : lexicalSimilarity(query.text, `${entry.text} ${entry.solution}`);

  const environment = environmentMatch(query.environment, entry.environment);
  const success = successRate(entry.successCount, entry.failureCount);
  const recency = recencyScore(entry.lastUsedAt || entry.updatedAt, query.now);
  const usage = usageScore(entry.useCount);

  const actionMatch =
    query.tool && entry.scope?.tool && query.tool === entry.scope.tool ? 1 : 0;
  const exactSignature =
    query.errorSignature && entry.scope?.errorSignature === query.errorSignature
      ? 1
      : 0;

  const base =
    weights.semantic * semantic +
    weights.environment * environment +
    weights.success * success +
    weights.recency * recency +
    weights.usage * usage +
    weights.actionMatch * actionMatch;

  // Confidence dampens uncertain memories but never zeroes them out.
  const confidenceFactor = 0.5 + 0.5 * clamp01(entry.confidence);
  const statusBoost = STATUS_BOOST[entry.status] ?? 1;
  const pinnedBoost = entry.pinned ? 1.25 : 1;
  const confidenceFactor2 = confidenceFactor * statusBoost * pinnedBoost;

  const typeBoost = entry.type === "procedure" ? 1.05 : 1;

  const score = clamp01(
    base * confidenceFactor2 * typeBoost + exactSignature * EXACT_SIGNAL_BOOST * confidenceFactor,
  );

  return {
    entry,
    score,
    parts: {
      semantic,
      environment,
      success,
      recency,
      usage,
      actionMatch,
      exactSignalBoost: exactSignature,
      confidence: entry.confidence,
    },
  };
}

export function rankMemories(
  entries: MemoryEntry[],
  query: MemoryQuery,
  weights: RankWeights = DEFAULT_RANK_WEIGHTS,
): RankedMemory[] {
  return entries
    .map((entry) => scoreMemory(entry, query, weights))
    .sort((left, right) => right.score - left.score);
}

/** Environment used for a neutral (no-query) ordering. */
export function neutralQuery(environment: EnvironmentSnapshot, now = Date.now()): MemoryQuery {
  return { text: "", embedding: [], environment, now, limit: Number.MAX_SAFE_INTEGER };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
