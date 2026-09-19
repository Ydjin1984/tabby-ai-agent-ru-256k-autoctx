/**
 * Task Outcome layer — the level above a single command.
 *
 * `command success != task success`: an agent can run `npm install` and
 * `npm run build` successfully and still fail the user's actual goal. Task
 * outcomes capture that, and the metrics derived from them are how you can see
 * whether the agent is actually getting smarter over time.
 */

import { TaskOutcome } from "./types";

export interface TaskMetrics {
  tasks: number;
  completed: number;
  completedRate: number;
  firstAttemptSuccesses: number;
  /** First Attempt Success Rate: solved on the first approach / solved tasks. */
  firstAttemptSuccessRate: number;
  averageAttemptsBeforeSuccess: number;
  memoryHitRate: number;
  memoryAssistedSuccessRate: number;
  badMemoryRate: number;
  procedureReuseRate: number;
}

export function computeTaskMetrics(
  outcomes: TaskOutcome[],
  extra: { badMemoryRate?: number; procedureReuseRate?: number } = {},
): TaskMetrics {
  const tasks = outcomes.length;
  const completedTasks = outcomes.filter((outcome) => outcome.completed);
  const completed = completedTasks.length;
  const firstAttemptSuccesses = completedTasks.filter(
    (outcome) => outcome.firstAttemptSuccess,
  ).length;
  const memoryAssistedCompleted = completedTasks.filter(
    (outcome) => outcome.memoryAssisted,
  ).length;
  const memoryAssisted = outcomes.filter((outcome) => outcome.memoryAssisted).length;

  const attemptsBeforeSuccess = completedTasks.map((outcome) => {
    const index = outcome.attempts.findIndex((attempt) => attempt.outcome === "success");
    return index >= 0 ? index + 1 : outcome.attempts.length;
  });
  const averageAttemptsBeforeSuccess =
    attemptsBeforeSuccess.length > 0
      ? attemptsBeforeSuccess.reduce((sum, value) => sum + value, 0) /
        attemptsBeforeSuccess.length
      : 0;

  return {
    tasks,
    completed,
    completedRate: tasks > 0 ? completed / tasks : 0,
    firstAttemptSuccesses,
    firstAttemptSuccessRate: completed > 0 ? firstAttemptSuccesses / completed : 0,
    averageAttemptsBeforeSuccess,
    memoryHitRate: tasks > 0 ? memoryAssisted / tasks : 0,
    memoryAssistedSuccessRate:
      completed > 0 ? memoryAssistedCompleted / completed : 0,
    badMemoryRate: extra.badMemoryRate ?? 0,
    procedureReuseRate: extra.procedureReuseRate ?? 0,
  };
}

/** Finalize a task from its raw attempts into a [[TaskOutcome]]. */
export function buildTaskOutcome(input: {
  taskId: string;
  sessionId: string;
  goal: string;
  startedAt: number;
  completedAt: number;
  attempts: TaskOutcome["attempts"];
  memoryAssisted: boolean;
  finalValidation?: string | null;
}): TaskOutcome {
  const attempts = input.attempts ?? [];
  const successIndex = attempts.findIndex((attempt) => attempt.outcome === "success");
  const lastAttempt = attempts[attempts.length - 1];
  const firstAttemptSuccess = attempts.length > 0 && attempts[0].outcome === "success";
  const completed =
    Boolean(lastAttempt) &&
    lastAttempt.outcome === "success" &&
    attempts
      .slice(attempts.indexOf(lastAttempt))
      .every((attempt) => attempt.outcome !== "failure");

  const successfulStrategy =
    successIndex >= 0 ? attempts[successIndex].command : null;

  return {
    taskId: input.taskId,
    sessionId: input.sessionId,
    goal: input.goal,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    attempts,
    completed,
    completionConfidence: completed && lastAttempt ? lastAttempt.score : 0,
    firstAttemptSuccess,
    successfulStrategy,
    failedStrategies: Array.from(
      new Set(
        attempts
          .filter((attempt) => attempt.outcome === "failure")
          .map((attempt) => attempt.command),
      ),
    ),
    finalValidation: input.finalValidation ?? (completed ? "command succeeded" : null),
    memoryAssisted: input.memoryAssisted,
  };
}
