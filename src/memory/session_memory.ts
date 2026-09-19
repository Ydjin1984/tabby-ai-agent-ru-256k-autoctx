/**
 * Session memory — what is happening right now in the current panel session.
 *
 * This never touches disk. It is a compact, rolling state (goal, environment,
 * attempts) that the [[ContextBuilder]] can hand to the model without dumping
 * the whole terminal log into the prompt.
 */

import { CommandAttempt, CommandOutcome, EnvironmentSnapshot, TaskOutcome } from "./types";
import { emptyEnvironment } from "./environment";
import { commandSignature, truncate } from "./text";
import { buildTaskOutcome } from "./task_outcome";

export interface SessionSnapshot {
  sessionId: string;
  taskId: string;
  goal: string;
  environment: EnvironmentSnapshot;
  startedAt: number;
  attempts: CommandAttempt[];
  facts: string[];
  lastAssistant: string;
  lastUserMessage: string;
}

export interface RecordAttemptInput {
  command: string;
  outcome: CommandOutcome;
  output: string;
  errorSignature: string | null;
  successScore: number;
  postconditionMet?: boolean | null;
  timestamp: number;
}

export interface SessionMemoryOptions {
  now?: () => number;
  maxAttempts?: number;
  outputCharLimit?: number;
  sessionId?: string;
}

let attemptCounter = 0;

export class SessionMemory {
  private goal = "";
  private environment: EnvironmentSnapshot = emptyEnvironment();
  private startedAt: number;
  private attempts: CommandAttempt[] = [];
  private facts: string[] = [];
  private lastAssistant = "";
  private lastUserMessage = "";
  private extractionKeys = new Set<string>();
  private now: () => number;
  private maxAttempts: number;
  private outputCharLimit: number;
  private sessionId: string;
  private taskCounter = 0;
  private taskId = "task-0";
  private currentTask: {
    taskId: string;
    goal: string;
    startedAt: number;
    attempts: CommandAttempt[];
    memoryAssisted: boolean;
  } | null = null;
  private completedTasks: TaskOutcome[] = [];
  private maxCompletedTasks = 100;
  /** Итог задачи, закрытой стартом новой цели (см. [[setGoal]]). */
  private deferredOutcome: TaskOutcome | null = null;

  constructor(options: SessionMemoryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 40;
    this.outputCharLimit = options.outputCharLimit ?? 4000;
    this.sessionId =
      options.sessionId ??
      `sess-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.startedAt = this.now();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTaskId(): string {
    return this.taskId;
  }

  setEnvironment(environment: EnvironmentSnapshot): void {
    this.environment = environment;
  }

  getEnvironment(): EnvironmentSnapshot {
    return this.environment;
  }

  setGoal(goal: string): void {
    const value = (goal ?? "").trim();
    if (value && value !== this.goal) {
      // Незакрытая задача (пользователь нажал «стоп», запрос упал) не должна
      // исчезать молча: откладываем её итог, его сохранит вызывающий (finishTurn).
      if (this.currentTask?.attempts.length) {
        this.deferredOutcome = this.finalizeCurrentTask();
      } else {
        this.currentTask = null;
      }
      this.taskId = `task-${++this.taskCounter}`;
      this.goal = truncate(value, 500);
      this.currentTask = {
        taskId: this.taskId,
        goal: this.goal,
        startedAt: this.now(),
        attempts: [],
        memoryAssisted: false,
      };
    }
  }

  markMemoryAssisted(): void {
    if (this.currentTask) {
      this.currentTask.memoryAssisted = true;
    }
  }

  /** Close the active task and produce its [[TaskOutcome]]. */
  finalizeCurrentTask(finalValidation?: string | null): TaskOutcome | null {
    const task = this.currentTask;
    this.currentTask = null;
    if (!task || !task.attempts.length) {
      return null;
    }
    const outcome = buildTaskOutcome({
      taskId: task.taskId,
      sessionId: this.sessionId,
      goal: task.goal || this.goal,
      startedAt: task.startedAt,
      completedAt: this.now(),
      attempts: task.attempts.map((attempt) => ({
        command: attempt.command,
        outcome: attempt.outcome,
        score: attempt.successScore,
      })),
      memoryAssisted: task.memoryAssisted,
      finalValidation,
    });
    this.completedTasks.push(outcome);
    if (this.completedTasks.length > this.maxCompletedTasks) {
      this.completedTasks = this.completedTasks.slice(-this.maxCompletedTasks);
    }
    return outcome;
  }

  getCompletedTasks(): TaskOutcome[] {
    return [...this.completedTasks];
  }

  /**
   * Итог задачи, отложенный при старте новой цели. Забирает и обнуляет: вызывающий
   * сохраняет его так же, как обычный finishTurn.
   */
  takeDeferredOutcome(): TaskOutcome | null {
    const outcome = this.deferredOutcome;
    this.deferredOutcome = null;
    return outcome;
  }

  setLastAssistant(text: string): void {
    this.lastAssistant = truncate(text ?? "", 600);
  }

  addFact(fact: string): void {
    const value = (fact ?? "").trim();
    if (value && !this.facts.includes(value)) {
      this.facts.push(value);
    }
  }

  recordAttempt(input: RecordAttemptInput): CommandAttempt {
    attemptCounter = (attemptCounter + 1) % 0xffff;
    const attempt: CommandAttempt = {
      id: `attempt-${input.timestamp.toString(36)}-${attemptCounter.toString(36)}`,
      sessionId: this.sessionId,
      command: input.command,
      normalizedCommand: commandSignature(input.command),
      outcome: input.outcome,
      output: truncate(input.output ?? "", this.outputCharLimit),
      errorSignature: input.errorSignature,
      successScore: input.successScore,
      postconditionMet: input.postconditionMet ?? null,
      timestamp: input.timestamp,
    };
    this.attempts.push(attempt);
    if (this.attempts.length > this.maxAttempts) {
      this.attempts = this.attempts.slice(-this.maxAttempts);
    }
    if (!this.currentTask) {
      this.currentTask = {
        taskId: this.taskId,
        goal: this.goal,
        startedAt: this.now(),
        attempts: [],
        memoryAssisted: false,
      };
    }
    this.currentTask.attempts.push(attempt);
    return attempt;
  }

  getAttempts(): CommandAttempt[] {
    return [...this.attempts];
  }

  hasExtracted(key: string): boolean {
    return this.extractionKeys.has(key);
  }

  markExtracted(key: string): void {
    this.extractionKeys.add(key);
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      taskId: this.taskId,
      goal: this.goal,
      environment: this.environment,
      startedAt: this.startedAt,
      attempts: [...this.attempts],
      facts: [...this.facts],
      lastAssistant: this.lastAssistant,
      lastUserMessage: this.lastUserMessage,
    };
  }

  recordUserMessage(text: string): void {
    this.lastUserMessage = truncate(text ?? "", 500);
  }

  reset(): void {
    this.goal = "";
    this.attempts = [];
    this.facts = [];
    this.lastAssistant = "";
    this.lastUserMessage = "";
    this.extractionKeys.clear();
    this.taskCounter = 0;
    this.taskId = "task-0";
    this.currentTask = null;
    this.deferredOutcome = null;
    this.completedTasks = [];
    this.startedAt = this.now();
  }
}
