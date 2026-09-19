/**
 * Memory Consolidation — the "sleep" pass.
 *
 * Runs periodically (and on startup) to merge duplicate episodes, promote
 * proven episodes into candidate procedures, resolve outcome supersession,
 * decay confidence of stale advice, prune memories that stopped working and cap
 * the database size.
 */

import { MemoryDatabase } from "./store";
import { MemoryEntry, ProcedureStatus } from "./types";
import {
  createMemoryEntry,
  ensureEmbedding,
  memoryMergeKey,
  mergeMemoryEntry,
  statusFromSessions,
  statusRank,
} from "./entry";
import { clamp01, confidenceFromCounts, decayConfidence, successRate } from "./scoring";
import { recencyScore } from "./ranker";
import { environmentKey } from "./environment";
import { fnv1a } from "./text";

export interface ConsolidationOptions {
  now?: number;
  /** Promote an episode into a procedure at/above this score. */
  promoteScore?: number;
  /** …or once it has succeeded this many times. */
  promoteSuccessCount?: number;
  decayAfterDays?: number;
  decayFactor?: number;
  minConfidence?: number;
  maxEntries?: number;
}

export interface ConsolidationStats {
  merged: number;
  promoted: number;
  superseded: number;
  decayed: number;
  pruned: number;
  total: number;
}

export const DEFAULT_CONSOLIDATION_OPTIONS: Required<ConsolidationOptions> = {
  now: 0,
  promoteScore: 0.8,
  promoteSuccessCount: 2,
  decayAfterDays: 30,
  decayFactor: 0.9,
  minConfidence: 0.15,
  maxEntries: 500,
};

/**
 * How long an unused environment fact may live before consolidation drops it.
 * Facts are re-observed from the live environment for free, so keeping a stale
 * `cwd` or `tools` fact around only adds noise to every prompt.
 */
export const FACT_STALE_DAYS = 120;

export function consolidateDatabase(
  db: MemoryDatabase,
  options: ConsolidationOptions = {},
): ConsolidationStats {
  const config = { ...DEFAULT_CONSOLIDATION_OPTIONS, ...options };
  const now = config.now || Date.now();
  const stats: ConsolidationStats = {
    merged: 0,
    promoted: 0,
    superseded: 0,
    decayed: 0,
    pruned: 0,
    total: 0,
  };

  // 1. Merge duplicates and refresh confidence/status from counts.
  const byKey = new Map<string, MemoryEntry>();
  const order: string[] = [];
  for (const raw of db.all()) {
    const entry = refresh(ensureEmbedding(raw), now);
    const key = `${entry.type}::${memoryMergeKey(entry)}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, mergeMemoryEntry(existing, entry, now));
      stats.merged++;
    } else {
      byKey.set(key, entry);
      order.push(key);
    }
  }
  let entries = order.map((key) => byKey.get(key)!);

  // 2. Promote proven episodes into candidate procedures (durable learning).
  const promoted = new Map<string, MemoryEntry>();
  for (const episode of entries) {
    if (episode.type !== "episode") {
      continue;
    }
    const qualifies =
      episode.score >= config.promoteScore ||
      episode.successCount >= config.promoteSuccessCount;
    if (!qualifies || !episode.action) {
      continue;
    }
    const key = `${environmentKey(episode.environment)}::${episode.action}`;
    const existing = promoted.get(key);
    promoted.set(
      key,
      existing
        ? mergeMemoryEntry(existing, toProcedureDraft(episode, now), now)
        : toProcedureDraft(episode, now),
    );
    episode.data = { ...episode.data, consolidated: true };
  }
  for (const procedure of promoted.values()) {
    const existingProcedure = entries.find(
      (entry) => entry.type === "procedure" && memoryMergeKey(entry) === memoryMergeKey(procedure),
    );
    if (existingProcedure) {
      const merged = mergeMemoryEntry(existingProcedure, procedure, now);
      entries = entries.map((entry) => (entry.id === existingProcedure.id ? merged : entry));
    } else {
      entries.push(procedure);
    }
    stats.promoted++;
  }

  // 3. Resolve outcome supersession: a strictly stronger solution for the same
  //    problem in the same environment replaces the older one.
  entries = resolveSupersession(entries, now, stats);

  // 4. Decay confidence of stale memories.
  entries = entries.map((entry) => {
    const ageDays = (now - (entry.lastUsedAt || entry.updatedAt)) / 86_400_000;
    if (ageDays <= config.decayAfterDays || entry.type === "fact") {
      return entry;
    }
    stats.decayed++;
    return {
      ...entry,
      confidence: decayConfidence(entry.confidence, config.decayFactor),
      updatedAt: now,
    };
  });

  // 5. Prune memories that stopped working or were never used.
  const floor = config.minConfidence;
  entries = entries.filter((entry) => {
    const ageDays = (now - (entry.lastUsedAt || entry.updatedAt)) / 86_400_000;
    const threshold = entry.type === "avoid" ? floor * 0.6 : floor;

    // Facts are cheap to re-observe, so they age out by staleness instead of by
    // confidence: an environment fact nobody has needed for months describes a
    // machine that has since changed. Pinned and actually-used facts survive.
    if (entry.type === "fact") {
      if (entry.pinned || entry.useCount > 0) {
        return true;
      }
      if (ageDays > FACT_STALE_DAYS) {
        stats.pruned++;
        return false;
      }
      return true;
    }

    if (entry.confidence < threshold) {
      stats.pruned++;
      return false;
    }
    if (entry.useCount === 0 && ageDays > 90 && entry.confidence < 0.45) {
      stats.pruned++;
      return false;
    }
    return true;
  });

  // 6. Cap the database, keeping the most valuable memories.
  if (entries.length > config.maxEntries) {
    const beforeCap = entries.length;
    entries = [...entries]
      .sort((a, b) => memoryValue(b, now) - memoryValue(a, now))
      .slice(0, config.maxEntries);
    stats.pruned += beforeCap - entries.length;
  }

  db.replaceAll(entries);
  stats.total = entries.length;
  return stats;
}

function resolveSupersession(
  entries: MemoryEntry[],
  now: number,
  stats: ConsolidationStats,
): MemoryEntry[] {
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (entry.type !== "procedure" || entry.status === "superseded") {
      continue;
    }
    const key = `${environmentKey(entry.environment)}|${entry.scope.tool}|${entry.scope.errorSignature ?? "none"}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const supersededById = new Map<string, string>();
  const conflictById = new Map<string, string>();
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) {
      continue;
    }
    const winner = [...group].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        successRate(b.successCount, b.failureCount) - successRate(a.successCount, a.failureCount) ||
        b.successCount - a.successCount,
    )[0];
    for (const candidate of group) {
      if (candidate.id === winner.id || !candidate.action) {
        continue;
      }
      if (candidate.action === winner.action) {
        continue;
      }
      const strictlyWeaker =
        winner.successCount > candidate.successCount &&
        winner.confidence > candidate.confidence;
      if (strictlyWeaker) {
        supersededById.set(candidate.id, winner.id);
      }
    }

    // Anything left with a different action is a genuine conflict, not a
    // supersession: mark a conflict set so retrieval shows only the best one.
    const remaining = group.filter(
      (candidate) => !supersededById.has(candidate.id) && candidate.action,
    );
    const distinctActions = new Set(remaining.map((candidate) => candidate.action));
    if (distinctActions.size > 1) {
      const conflictSetId = `conflict-${fnv1a(key).toString(36)}`;
      for (const candidate of remaining) {
        conflictById.set(candidate.id, conflictSetId);
      }
    }
  }

  if (!supersededById.size && !conflictById.size) {
    return entries;
  }
  stats.superseded += supersededById.size;
  return entries.map((entry) => {
    const winnerId = supersededById.get(entry.id);
    if (winnerId) {
      return {
        ...entry,
        status: "superseded" as ProcedureStatus,
        supersededBy: winnerId,
        updatedAt: now,
      };
    }
    const conflictSetId = conflictById.get(entry.id);
    if (conflictSetId) {
      return {
        ...entry,
        conflictSetId,
        data: { ...entry.data, conflict: true },
        updatedAt: now,
      };
    }
    return entry;
  });
}

function refresh(entry: MemoryEntry, now: number): MemoryEntry {
  const base =
    entry.successCount === 0 && entry.failureCount === 0
      ? { ...entry, confidence: clamp01(entry.confidence) }
      : {
          ...entry,
          confidence: Math.max(
            clamp01(entry.confidence),
            confidenceFromCounts(entry.successCount, entry.failureCount),
          ),
          updatedAt: entry.updatedAt || now,
        };

  if (entry.type === "procedure" && entry.status !== "superseded") {
    const implied = statusFromSessions(entry.sessionIds?.length ?? 0);
    if (statusRank(implied) > statusRank(base.status)) {
      return { ...base, status: implied };
    }
  }
  return base;
}

function toProcedureDraft(episode: MemoryEntry, now: number): MemoryEntry {
  return createMemoryEntry({
    type: "procedure",
    text: episode.text,
    solution: episode.solution,
    action: episode.action,
    environment: episode.environment,
    scope: episode.scope,
    tags: episode.tags,
    successCount: episode.successCount,
    failureCount: episode.failureCount,
    score: episode.score,
    sessionIds: episode.sessionIds,
    provenance: episode.provenance,
    data: {
      problemSignature: episode.data.problemSignature,
      errorSignature: episode.data.errorSignature,
      appliesWhen: episode.data.appliesWhen,
      doNotApplyWhen: episode.data.doNotApplyWhen,
      sourceIds: [episode.id],
    },
    now,
  });
}

function memoryValue(entry: MemoryEntry, now: number): number {
  const recency = 0.5 + 0.5 * recencyScore(entry.lastUsedAt || entry.updatedAt, now);
  return entry.confidence * (1 + Math.log1p(entry.useCount)) * recency;
}
