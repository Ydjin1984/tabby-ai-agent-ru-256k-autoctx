/**
 * Retrieval — pick the memories worth telling the model about.
 *
 * Two stages:
 *   1. cheap structural filtering (OS, shell, tool, cwd type, error signature,
 *      superseded) to remove memories that are simply not applicable;
 *   2. semantic + outcome ranking of the survivors.
 *
 * Negative memories ("do not try") get a reserved slot but are always scoped to
 * a compatible environment, so an avoid rule learned on Windows never blocks a
 * valid command on Linux.
 */

import { MemoryEntry, MemoryQuery, RankedMemory } from "./types";
import { rankMemories } from "./ranker";
import { memoryMergeKey } from "./entry";
import { environmentMatch } from "./environment";
import { cosineSimilarity } from "./text";

export interface RetrievalOptions {
  minScore?: number;
  avoidLimit?: number;
  weights?: import("./ranker").RankWeights;
}

export function retrieveMemories(
  entries: MemoryEntry[],
  query: MemoryQuery,
  options: RetrievalOptions = {},
): RankedMemory[] {
  const minScore = options.minScore ?? 0.28;
  const avoidLimit = options.avoidLimit ?? 2;

  const candidates = entries.filter((entry) => stage1Eligible(entry, query));
  const ranked = rankMemories(candidates, query, options.weights);

  const main: RankedMemory[] = [];
  for (const item of ranked) {
    if (item.entry.type === "avoid") {
      continue;
    }
    if (item.score < minScore) {
      continue;
    }
    if (main.some((existing) => isDuplicate(existing.entry, item.entry))) {
      continue;
    }
    if (
      item.entry.conflictSetId &&
      main.some((existing) => existing.entry.conflictSetId === item.entry.conflictSetId)
    ) {
      // Conflicting solutions for the same trigger: only the best one is shown.
      continue;
    }
    main.push(item);
    if (main.length >= query.limit) {
      break;
    }
  }

  const avoid = ranked
    .filter(
      (item) =>
        item.entry.type === "avoid" &&
        item.score >= minScore * 0.7 &&
        avoidScopeMatches(item.entry, query),
    )
    .filter((item) => !main.some((existing) => isDuplicate(existing.entry, item.entry)))
    .slice(0, avoidLimit);

  return [...main, ...avoid];
}

/** Cheap structural gate applied before any embedding comparison. */
export function stage1Eligible(entry: MemoryEntry, query: MemoryQuery): boolean {
  if (entry.disabled || entry.type === "task") {
    return false;
  }
  if (entry.status === "superseded") {
    return false;
  }
  if (query.types?.length && !query.types.includes(entry.type)) {
    return false;
  }

  const env = query.environment;
  const entryEnv = entry.environment;
  if (env.os && entryEnv.os && env.os !== entryEnv.os) {
    return false;
  }
  if (env.shell && entryEnv.shell && env.shell !== entryEnv.shell) {
    // cmd.exe and powershell are different worlds; do not mix them.
    return false;
  }

  if (entry.type === "avoid") {
    return avoidScopeMatches(entry, query);
  }

  if (query.cwdType && entry.scope.cwdType && query.cwdType !== entry.scope.cwdType) {
    // A node-project fix is probably irrelevant to a python project, but allow
    // it through when the environment otherwise matches strongly.
    if (environmentMatch(env, entryEnv) < 0.75) {
      return false;
    }
  }

  return true;
}

/**
 * Avoid rules are only surfaced when the environment is compatible AND either
 * the error signature matches or the environment match is high.
 */
function avoidScopeMatches(entry: MemoryEntry, query: MemoryQuery): boolean {
  const match = environmentMatch(query.environment, entry.environment);
  if (match < 0.6) {
    return false;
  }
  if (query.errorSignature && entry.scope.errorSignature) {
    return query.errorSignature === entry.scope.errorSignature;
  }
  return match >= 0.85;
}

function isDuplicate(a: MemoryEntry, b: MemoryEntry): boolean {
  if (a.id === b.id) {
    return true;
  }
  if (a.type === b.type && memoryMergeKey(a) === memoryMergeKey(b)) {
    return true;
  }
  if (
    a.type === b.type &&
    a.action &&
    a.action === b.action &&
    cosineSimilarity(a.embedding ?? [], b.embedding ?? []) > 0.98
  ) {
    return true;
  }
  return false;
}
