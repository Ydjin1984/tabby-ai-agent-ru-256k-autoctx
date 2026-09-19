/**
 * Success scoring and confidence bookkeeping.
 *
 * `exit_code == 0` is not enough: `del *` succeeds with exit code 0 but may be
 * exactly the wrong thing. Every observed command is scored from several weak
 * signals instead of trusting a single one, and only memories that clear the
 * bar are allowed to become procedures.
 */

export interface SuccessSignals {
  /** Process finished without a detected error. */
  exitCodeZero: boolean;
  /** The output contained the expected/non-error result. */
  expectedOutputMatched: boolean;
  /** A previous error signature disappeared after the change. */
  validated: boolean;
  /** The change actually resolved the current goal (failure → success). */
  goalCompleted: boolean;
  /** The user explicitly confirmed the result. */
  userConfirmed: boolean;
}

export interface SuccessWeights {
  exitCodeZero: number;
  expectedOutputMatched: number;
  validated: number;
  goalCompleted: number;
  userConfirmed: number;
}

export const DEFAULT_SUCCESS_WEIGHTS: SuccessWeights = {
  exitCodeZero: 0.25,
  expectedOutputMatched: 0.2,
  validated: 0.2,
  goalCompleted: 0.25,
  userConfirmed: 0.1,
};

export function computeSuccessScore(
  signals: Partial<SuccessSignals>,
  weights: SuccessWeights = DEFAULT_SUCCESS_WEIGHTS,
): number {
  let score = 0;
  if (signals.exitCodeZero) {
    score += weights.exitCodeZero;
  }
  if (signals.expectedOutputMatched) {
    score += weights.expectedOutputMatched;
  }
  if (signals.validated) {
    score += weights.validated;
  }
  if (signals.goalCompleted) {
    score += weights.goalCompleted;
  }
  if (signals.userConfirmed) {
    score += weights.userConfirmed;
  }
  return clamp01(score);
}

/** Laplace-smoothed success rate in [0, 1]; 0.5 with no observations. */
export function successRate(successCount: number, failureCount: number): number {
  const success = Math.max(0, successCount);
  const failure = Math.max(0, failureCount);
  return (success + 1) / (success + failure + 2);
}

export function confidenceFromCounts(successCount: number, failureCount: number): number {
  return clamp01(successRate(successCount, failureCount));
}

/**
 * Exponential moving average update used when a memory is reinforced by a live
 * result. Failures move confidence down faster than successes move it up, so
 * broken advice is retired quickly.
 */
export function bumpConfidence(current: number, success: boolean): number {
  const rate = success ? 0.08 : 0.16;
  return clamp01(current + (success ? rate : -rate));
}

export function decayConfidence(current: number, factor: number): number {
  return clamp01(current * factor);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
