/**
 * Core types of the agent memory layer.
 *
 * The memory layer is intentionally framework-free (no Angular, no tabby-*):
 * every module here is plain TypeScript so it can be unit-tested with node and
 * reused outside the panel. The UI only talks to [[MemoryManager]] through the
 * small [[MemoryBridge]] interface.
 */

export type MemoryType = "episode" | "procedure" | "lesson" | "avoid" | "fact" | "task";

export type CommandOutcome = "success" | "failure" | "unknown";

/**
 * Lifecycle of a procedure (and, less strictly, of an avoid rule):
 * one success yields a candidate, independent successes validate it, and only
 * repeated success across sessions makes it trusted.
 */
export type ProcedureStatus = "candidate" | "validated" | "trusted" | "superseded";

/** Snapshot of the environment a command was executed in. */
export interface EnvironmentSnapshot {
  os: string;
  osVersion: string;
  shell: string;
  cwd: string;
  cwdType: string;
  runtime: string;
  tools: string[];
}

/**
 * The narrow context an avoid-rule or procedure is valid in. Negative memory is
 * always scoped: "npm install failed here" must not become a global ban.
 */
export interface MemoryScope {
  tool: string;
  errorSignature: string | null;
  cwdType: string;
  os: string;
  shell: string;
}

/** Where a memory came from — enough to justify why it is being applied. */
export interface Provenance {
  sessionId: string;
  taskId: string;
  createdAt: number;
  updatedAt: number;
  sourceAttemptIds: string[];
  command: string;
  errorSignature: string | null;
  environmentKey: string;
  userConfirmed: boolean;
  note?: string;
}

/** A single executed shell command and its observed result. */
export interface CommandAttempt {
  id: string;
  sessionId: string;
  command: string;
  normalizedCommand: string;
  outcome: CommandOutcome;
  output: string;
  errorSignature: string | null;
  successScore: number;
  /** Result of the command-specific postcondition check, when one applies. */
  postconditionMet: boolean | null;
  timestamp: number;
}

/** Type-specific payload attached to a [[MemoryEntry]]. */
export interface MemoryData {
  problemSignature?: string;
  errorSignature?: string | null;
  cause?: string;
  attempts?: CommandAttempt[];
  appliesWhen?: string[];
  doNotApplyWhen?: string[];
  avoid?: string[];
  sourceIds?: string[];
  consolidated?: boolean;
  postcondition?: string;
  [key: string]: any;
}

/**
 * A single record in the long-term memory store. Episodes, procedures, lessons,
 * avoid-rules and facts all share this shape so retrieval and persistence can
 * treat them uniformly.
 */
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  /** Searchable primary text: the problem, trigger or fact. */
  text: string;
  /** Human-readable solution / action text. */
  solution: string;
  /** Normalized command a procedure or episode resolved to. */
  action: string;
  environment: EnvironmentSnapshot;
  scope: MemoryScope;
  embedding: number[];
  /** Id of the provider model that produced this vector. */
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: number;
  confidence: number;
  status: ProcedureStatus;
  successCount: number;
  failureCount: number;
  useCount: number;
  /** Distinct sessions that independently confirmed this memory. */
  sessionIds: string[];
  /** Best observed success score for this memory. */
  score: number;
  tags: string[];
  data: MemoryData;
  provenance: Provenance;
  /** Id of a memory that replaced this one (outcome supersession). */
  supersededBy?: string | null;
  /** Memories in the same conflict set offer competing solutions. */
  conflictSetId?: string | null;
  /** Manually disabled from the Inspector; excluded from retrieval. */
  disabled?: boolean;
  /** Pinned memories are always considered during retrieval. */
  pinned?: boolean;
}

/**
 * Result of a whole task (a goal), above the level of a single command. A task
 * can fail even when every command exited 0.
 */
export interface TaskOutcome {
  taskId: string;
  sessionId: string;
  goal: string;
  startedAt: number;
  completedAt: number;
  attempts: Array<{
    command: string;
    outcome: CommandOutcome;
    score: number;
  }>;
  completed: boolean;
  completionConfidence: number;
  firstAttemptSuccess: boolean;
  successfulStrategy: string | null;
  failedStrategies: string[];
  finalValidation: string | null;
  memoryAssisted: boolean;
}

/** Input used for ranking and retrieval. */
export interface MemoryQuery {
  text: string;
  embedding: number[];
  environment: EnvironmentSnapshot;
  now: number;
  limit: number;
  types?: MemoryType[];
  /** Cheap stage-1 signals. */
  tool?: string;
  errorSignature?: string | null;
  cwdType?: string;
}

export interface RankedMemory {
  entry: MemoryEntry;
  score: number;
  parts: {
    semantic: number;
    environment: number;
    success: number;
    recency: number;
    usage: number;
    actionMatch: number;
    exactSignalBoost: number;
    confidence: number;
  };
}

/** Observation passed by the chat loop after a tool has run. */
export interface ToolObservation {
  toolName: string;
  args: any;
  output: string;
  ok: boolean;
  errorMessage?: string;
}

/**
 * The only surface the chat session sees. Implemented by [[MemoryManager]] and
 * designed so that every method is safe to call even when memory is disabled.
 */
export interface MemoryBridge {
  readonly enabled: boolean;
  buildContext(userMessage: string): Promise<string | null>;
  observeUserMessage(text: string): Promise<void>;
  observeToolResult(observation: ToolObservation): Promise<void>;
  observeAssistantMessage(text: string): Promise<void>;
  finishTurn(): Promise<void>;
}
