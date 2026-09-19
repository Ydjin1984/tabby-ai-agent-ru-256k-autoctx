/**
 * Memory entry factory, merge helpers and lifecycle rules.
 */

import {
  EnvironmentSnapshot,
  MemoryData,
  MemoryEntry,
  MemoryScope,
  MemoryType,
  ProcedureStatus,
  Provenance,
} from "./types";
import { emptyEnvironment, environmentKey } from "./environment";
import { confidenceFromCounts } from "./scoring";
import { EMBEDDING_DIM, commandTool, embedText, fnv1a, truncate, unique } from "./text";
import { EMBEDDING_VERSION } from "./embeddings";
import { MemoryDatabase } from "./store";
import { redactSecrets } from "./secrets";

export interface CreateEntryInput {
  type: MemoryType;
  text: string;
  solution?: string;
  action?: string;
  environment?: EnvironmentSnapshot;
  scope?: Partial<MemoryScope>;
  tags?: string[];
  successCount?: number;
  failureCount?: number;
  score?: number;
  status?: ProcedureStatus;
  sessionIds?: string[];
  provenance?: Partial<Provenance>;
  data?: MemoryData;
  now?: number;
}

let idCounter = 0;

function nextId(type: MemoryType, now: number): string {
  idCounter = (idCounter + 1) % 0xffff;
  return `${type}-${now.toString(36)}-${idCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

const STATUS_RANK: Record<ProcedureStatus, number> = {
  superseded: 0,
  candidate: 1,
  validated: 2,
  trusted: 3,
};

export function statusRank(status: ProcedureStatus): number {
  return STATUS_RANK[status] ?? 0;
}

/** Status implied by the number of independent sessions that confirmed it. */
export function statusFromSessions(sessionCount: number): ProcedureStatus {
  if (sessionCount >= 3) {
    return "trusted";
  }
  if (sessionCount >= 2) {
    return "validated";
  }
  return "candidate";
}

export function createScope(
  environment: EnvironmentSnapshot,
  action: string,
  errorSignature: string | null,
  partial?: Partial<MemoryScope>,
): MemoryScope {
  return {
    tool: partial?.tool ?? commandTool(action) ?? "",
    errorSignature: partial?.errorSignature ?? errorSignature ?? null,
    cwdType: partial?.cwdType ?? environment.cwdType ?? "",
    os: partial?.os ?? environment.os ?? "",
    shell: partial?.shell ?? environment.shell ?? "",
  };
}

export function createProvenance(
  now: number,
  partial?: Partial<Provenance>,
): Provenance {
  return {
    sessionId: partial?.sessionId ?? "",
    taskId: partial?.taskId ?? "",
    createdAt: partial?.createdAt ?? now,
    updatedAt: now,
    sourceAttemptIds: partial?.sourceAttemptIds ?? [],
    command: partial?.command ?? "",
    errorSignature: partial?.errorSignature ?? null,
    environmentKey: partial?.environmentKey ?? "",
    userConfirmed: partial?.userConfirmed ?? false,
    note: partial?.note,
  };
}

export function createMemoryEntry(input: CreateEntryInput): MemoryEntry {
  const now = input.now ?? Date.now();
  const successCount = input.successCount ?? 0;
  const failureCount = input.failureCount ?? 0;
  const environment = input.environment ?? emptyEnvironment();
  const action = input.action ?? "";

  return embedEntry({
    id: nextId(input.type, now),
    type: input.type,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    text: redactSecrets(input.text),
    solution: redactSecrets(input.solution ?? ""),
    action: redactSecrets(action),
    environment,
    scope: createScope(
      environment,
      action,
      input.data?.errorSignature ?? null,
      input.scope,
    ),
    embedding: [],
    embeddingModel: "hashed-v1",
    embeddingDimensions: EMBEDDING_DIM,
    embeddingVersion: EMBEDDING_VERSION,
    confidence:
      successCount > 0 || failureCount > 0
        ? confidenceFromCounts(successCount, failureCount)
        : 0.5,
    status:
      input.status ??
      (input.type === "procedure"
        ? statusFromSessions((input.sessionIds ?? []).length)
        : // A fact is never born trusted: an observed environment detail is a
          // candidate until it is confirmed by real use (see `refresh()` in
          // consolidation.ts, which promotes by session count).
          input.type === "task"
          ? "trusted"
          : "candidate"),
    successCount,
    failureCount,
    useCount: 0,
    sessionIds: unique((input.sessionIds ?? []).filter(Boolean)),
    score: input.score ?? 0,
    tags: input.tags ? unique(input.tags.filter(Boolean)) : [],
    data: input.data ?? {},
    provenance: createProvenance(now, input.provenance),
    supersededBy: null,
    conflictSetId: null,
    disabled: false,
    pinned: false,
  });
}

export function embedEntry(entry: MemoryEntry): MemoryEntry {
  const parts = [entry.text, entry.solution, entry.action, entry.tags.join(" ")].filter(
    Boolean,
  );
  const vector = embedText(parts.join("\n"));
  return {
    ...entry,
    embedding: vector,
    embeddingModel: entry.embeddingModel || "hashed-v1",
    embeddingDimensions: vector.length,
    embeddingVersion: EMBEDDING_VERSION,
  };
}

/** Replace an entry's vector with one produced by an external provider. */
export function stampEmbedding(
  entry: MemoryEntry,
  vector: number[],
  model: string,
  dimensions: number,
): MemoryEntry {
  return {
    ...entry,
    embedding: vector,
    embeddingModel: model,
    embeddingDimensions: dimensions || vector.length,
    embeddingVersion: EMBEDDING_VERSION,
  };
}

/** Text that is embedded for an entry. */
export function entryEmbeddingText(entry: MemoryEntry): string {
  return [entry.text, entry.solution, entry.action, entry.tags.join(" ")]
    .filter(Boolean)
    .join("\n");
}

export function ensureEmbedding(entry: MemoryEntry): MemoryEntry {
  if (entry.embedding?.length) {
    return entry;
  }
  return embedEntry(entry);
}

/** Strip secrets from every persisted text field of an entry. */
export function redactMemoryEntry(entry: MemoryEntry): MemoryEntry {
  const outcome = entry.data?.taskOutcome;
  return {
    ...entry,
    text: redactSecrets(entry.text),
    solution: redactSecrets(entry.solution),
    action: redactSecrets(entry.action),
    tags: (entry.tags ?? []).map((tag) => redactSecrets(tag)),
    data: {
      ...entry.data,
      attempts: entry.data.attempts?.map((attempt) => ({
        ...attempt,
        command: redactSecrets(attempt.command),
        // Новые записи вывод команды не хранят; у старых он есть и должен чиститься.
        ...(attempt.output === undefined ? {} : { output: redactSecrets(attempt.output) }),
      })),
      avoid: entry.data.avoid?.map((item) => redactSecrets(item)),
      // Итог задачи несёт цель, стратегии и команды попыток: без этого секреты,
      // сохранённые старой версией, оставались в файле памяти навсегда.
      taskOutcome: outcome
        ? {
            ...outcome,
            goal: redactSecrets(outcome.goal ?? ""),
            successfulStrategy: outcome.successfulStrategy
              ? redactSecrets(outcome.successfulStrategy)
              : outcome.successfulStrategy,
            failedStrategies: (outcome.failedStrategies ?? []).map((strategy) =>
              redactSecrets(strategy),
            ),
            finalValidation: outcome.finalValidation
              ? redactSecrets(outcome.finalValidation)
              : outcome.finalValidation,
            attempts: (outcome.attempts ?? []).map((attempt) => ({
              ...attempt,
              command: redactSecrets(attempt.command),
            })),
          }
        : outcome,
    },
    provenance: {
      ...entry.provenance,
      command: redactSecrets(entry.provenance?.command ?? ""),
    },
  };
}

/**
 * Kind of an environment fact (`os`, `shell`, `runtime`, `cwd`, `cwd_type`,
 * `tools`). Falls back to the label before the colon so entries written by an
 * older build still merge correctly.
 */
export function factKindOf(entry: MemoryEntry): string {
  const kind = entry.data?.factKind;
  if (typeof kind === "string" && kind.trim()) {
    return kind.trim().toLowerCase();
  }
  return factLabelOf(entry).toLowerCase();
}

/** Human-readable label of a fact ("Рабочая директория", "Используемые инструменты"). */
export function factLabelOf(entry: MemoryEntry): string {
  const label = entry.data?.factLabel;
  if (typeof label === "string" && label.trim()) {
    return label.trim();
  }
  const colon = entry.text.indexOf(":");
  return (colon === -1 ? entry.text : entry.text.slice(0, colon)).trim();
}

/** Values carried by a fact entry. */
export function factValuesOf(entry: MemoryEntry): string[] {
  const values = entry.data?.factValues;
  if (Array.isArray(values) && values.length) {
    return unique(values.map((value) => String(value).trim()).filter(Boolean));
  }
  const colon = entry.text.indexOf(":");
  if (colon === -1) {
    return [];
  }
  return unique(
    entry.text
      .slice(colon + 1)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Fold two observations of the same environment fact into one entry.
 *
 * Multi-valued facts (`tools`) accumulate their values — an "инструменты" fact
 * must grow, not fork into one entry per command. Single-valued facts (cwd, os,
 * shell, runtime) take the freshest value: the working directory changed, it did
 * not multiply.
 */
function applyFactMerge(
  target: MemoryEntry,
  source: MemoryEntry,
  merged: MemoryEntry,
): MemoryEntry {
  const mode =
    source.data.factMode === "union" || target.data.factMode === "union"
      ? "union"
      : "replace";
  const label = factLabelOf(source) || factLabelOf(target);
  const targetValues = factValuesOf(target);
  const sourceValues = factValuesOf(source);
  const values =
    mode === "union"
      // Множество фактов не растёт бесконечно: держим последние 12 значений.
      ? unique([...targetValues, ...sourceValues]).slice(-12)
      : sourceValues.length
        ? sourceValues
        : targetValues;

  return {
    ...merged,
    text: `${label}: ${values.join(", ")}`,
    createdAt: Math.min(target.createdAt, source.createdAt),
    // The merged text differs from both inputs, so the stored vector is stale.
    // An empty vector + empty model id makes the next consolidation pass
    // re-embed it with whatever provider is active.
    embedding: [],
    embeddingModel: "",
    embeddingDimensions: 0,
    data: {
      ...merged.data,
      factKind: source.data.factKind ?? target.data.factKind,
      factLabel: label,
      factValues: values,
      factMode: mode,
    },
  };
}

/**
 * Stable key that decides which memories are "the same memory" and should be
 * merged instead of duplicated.
 */
export function memoryMergeKey(entry: MemoryEntry): string {
  const env = environmentKey(entry.environment);
  // Опыт разных проектов не сливаем: ключ окружения не содержит рабочего каталога,
  // поэтому процедуры/уроки двух проектов с одинаковым runtime считались «одной
  // памятью» и рекомендации одного проекта утекали в другой. Хеш cwd добавляется
  // только когда каталог известен — старые записи продолжают сливаться как раньше.
  const cwd = entry.environment?.cwd || "";
  const project = cwd ? `|${fnv1a(cwd).toString(36)}` : "";
  switch (entry.type) {
    case "episode":
      return `episode|${entry.data.problemSignature ?? ""}|${entry.action}|${env}${project}`;
    case "procedure":
      return `procedure|${entry.data.problemSignature ?? entry.scope.tool}|${entry.action}|${env}${project}`;
    case "lesson":
      // В ключ входит само решение: два урока об одной проблеме с разными решениями —
      // это две разные памяти, иначе второе решение терялось при слиянии.
      return `lesson|${entry.data.problemSignature ?? entry.text.toLowerCase()}|${entry.solution || entry.action}|${env}${project}`;
    case "avoid":
      return `avoid|${entry.data.problemSignature ?? entry.scope.tool}|${entry.data.errorSignature ?? ""}|${env}${project}`;
    case "task":
      return `task|${entry.data?.taskOutcome?.taskId ?? entry.text.toLowerCase()}`;
    case "fact":
    default:
      // Keyed by fact kind, not by the full text: "Используемые инструменты: a"
      // and "…: a, b" are the same memory, not two.
      return `fact|${factKindOf(entry)}|${env}`;
  }
}

function mergeAttempts(
  left: MemoryEntry["data"]["attempts"],
  right: MemoryEntry["data"]["attempts"],
): MemoryEntry["data"]["attempts"] {
  const merged = [...(left ?? []), ...(right ?? [])];
  const seen = new Set<string>();
  const result: NonNullable<MemoryEntry["data"]["attempts"]> = [];
  for (const attempt of merged) {
    const key = `${attempt.timestamp}|${attempt.command}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(attempt);
  }
  return result.slice(-24);
}

/** Fold `source` into `target`, combining counts, scores and provenance. */
export function mergeMemoryEntry(
  target: MemoryEntry,
  source: MemoryEntry,
  now = Date.now(),
): MemoryEntry {
  // Счётчики складываем только для одного и того же решения: иначе слияние двух
  // разных решений одной проблемы раздувало уверенность выжившей записи за счёт
  // чужих успехов, а альтернативное решение молча исчезало.
  const sameSolution =
    (target.solution || target.action) === (source.solution || source.action);
  const successCount = sameSolution
    ? target.successCount + source.successCount
    : Math.max(target.successCount, source.successCount);
  const failureCount = sameSolution
    ? target.failureCount + source.failureCount
    : Math.max(target.failureCount, source.failureCount);
  const sessionIds = unique([...target.sessionIds, ...source.sessionIds]);
  const lifecycleStatus = statusFromSessions(sessionIds.length);
  let status: ProcedureStatus =
    statusRank(target.status) >= statusRank(source.status) ? target.status : source.status;
  if (status === "superseded" && (target.status !== "superseded" || source.status !== "superseded")) {
    status = target.status === "superseded" ? source.status : target.status;
  }
  if (
    status !== "superseded" &&
    statusRank(lifecycleStatus) > statusRank(status)
  ) {
    status = lifecycleStatus;
  }

  const merged: MemoryEntry = {
    ...target,
    successCount,
    failureCount,
    useCount: Math.max(target.useCount, source.useCount),
    confidence: Math.max(
      confidenceFromCounts(successCount, failureCount),
      Math.max(target.confidence, source.confidence) * 0.99,
    ),
    score: Math.max(target.score, source.score),
    status,
    sessionIds,
    lastUsedAt: Math.max(target.lastUsedAt, source.lastUsedAt, now),
    updatedAt: now,
    tags: unique([...target.tags, ...source.tags]),
    scope: {
      tool: target.scope.tool || source.scope.tool,
      errorSignature: target.scope.errorSignature ?? source.scope.errorSignature,
      cwdType: target.scope.cwdType || source.scope.cwdType,
      os: target.scope.os || source.scope.os,
      shell: target.scope.shell || source.scope.shell,
    },
    conflictSetId: target.conflictSetId ?? source.conflictSetId ?? null,
    disabled: Boolean(target.disabled || source.disabled),
    pinned: Boolean(target.pinned || source.pinned),
    data: {
      ...target.data,
      ...source.data,
      attempts: mergeAttempts(target.data.attempts, source.data.attempts),
      avoid: unique([...(target.data.avoid ?? []), ...(source.data.avoid ?? [])]),
      appliesWhen: unique([
        ...(target.data.appliesWhen ?? []),
        ...(source.data.appliesWhen ?? []),
      ]),
      doNotApplyWhen: unique([
        ...(target.data.doNotApplyWhen ?? []),
        ...(source.data.doNotApplyWhen ?? []),
      ]),
      sourceIds: unique([
        ...(target.data.sourceIds ?? []),
        ...(source.data.sourceIds ?? []),
      ]).slice(-10),
    },
    provenance: {
      ...target.provenance,
      updatedAt: now,
      sessionId: target.provenance.sessionId || source.provenance.sessionId,
      taskId: target.provenance.taskId || source.provenance.taskId,
      command: target.provenance.command || source.provenance.command,
      errorSignature:
        target.provenance.errorSignature ?? source.provenance.errorSignature,
      environmentKey:
        target.provenance.environmentKey || source.provenance.environmentKey,
      userConfirmed:
        target.provenance.userConfirmed || source.provenance.userConfirmed,
      sourceAttemptIds: unique([
        ...(target.provenance.sourceAttemptIds ?? []),
        ...(source.provenance.sourceAttemptIds ?? []),
      ]).slice(-24),
    },
  };

  if (target.type === "fact" && source.type === "fact") {
    return applyFactMerge(target, source, merged);
  }
  return merged;
}

export function bumpEntryUsage(entry: MemoryEntry, now = Date.now()): MemoryEntry {
  return { ...entry, useCount: entry.useCount + 1, lastUsedAt: now };
}

export function summarizeEntry(entry: MemoryEntry, maxText = 240): string {
  const text = truncate(entry.text, maxText);
  const solution = entry.solution ? ` → ${truncate(entry.solution, 160)}` : "";
  return `${text}${solution}`;
}

export function entryEnvironmentKey(entry: MemoryEntry): string {
  return environmentKey(entry.environment);
}

/**
 * Insert a draft into the database, folding it into the matching memory when
 * one already exists (same type + merge key) instead of creating duplicates.
 */
export function mergeIntoDatabase(
  db: MemoryDatabase,
  draft: MemoryEntry,
  now = Date.now(),
): MemoryEntry {
  const key = memoryMergeKey(draft);
  const existing = db
    .all()
    .find((entry) => entry.type === draft.type && memoryMergeKey(entry) === key);
  if (existing) {
    const merged = mergeMemoryEntry(existing, draft, now);
    db.upsert(merged);
    return merged;
  }
  db.upsert(draft);
  return draft;
}

export function mergeManyIntoDatabase(
  db: MemoryDatabase,
  drafts: MemoryEntry[],
  now = Date.now(),
): MemoryEntry[] {
  return drafts.map((draft) => mergeIntoDatabase(db, draft, now));
}
