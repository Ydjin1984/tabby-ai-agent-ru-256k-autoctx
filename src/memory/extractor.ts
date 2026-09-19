/**
 * Memory Extractor — turn observed command outcomes into episodic, procedural,
 * semantic and negative memories.
 *
 * The default implementation is fully heuristic and offline. A custom
 * [[LessonSynthesizer]] can be supplied later (e.g. an LLM call) without
 * changing the rest of the pipeline.
 */

import { CommandAttempt, EnvironmentSnapshot, MemoryEntry } from "./types";
import { SessionSnapshot } from "./session_memory";
import { createMemoryEntry, createProvenance, createScope } from "./entry";
import {
  buildProblemSignature,
  commandTool,
  describeError,
  errorAdvice,
  sharesProblemFamily,
  truncate,
  unique,
} from "./text";
import { environmentConstraints, environmentExclusions, environmentKey } from "./environment";

export interface ExtractionResult {
  entries: MemoryEntry[];
  key: string | null;
}

export type LessonSynthesizer = (
  episode: MemoryEntry,
) => Promise<Partial<MemoryEntry> | null> | Partial<MemoryEntry> | null;

export class MemoryExtractor {
  private synthesizer?: LessonSynthesizer;

  constructor(synthesizer?: LessonSynthesizer) {
    this.synthesizer = synthesizer;
  }

  /** Stable key that prevents re-extracting the same experience repeatedly. */
  extractionKey(snapshot: SessionSnapshot): string | null {
    const attempts = snapshot.attempts;
    const successes = attempts.filter(
      (attempt) => attempt.outcome === "success" && attempt.successScore >= 0.6,
    );
    const failures = attempts.filter((attempt) => attempt.outcome === "failure");
    if (!successes.length) {
      return failures.length >= 2
        ? `avoid|${unique(failures.map((f) => f.normalizedCommand)).join(",")}`
        : null;
    }
    const solution = successes[successes.length - 1];
    const related = failures.filter((failure) => sharesProblemFamily(failure, solution));
    const problem = related[0] ?? failures[0];
    if (!problem) {
      return null;
    }
    return `${buildProblemSignature(problem.normalizedCommand, problem.errorSignature)}|${solution.normalizedCommand}`;
  }

  async extractFromSession(
    snapshot: SessionSnapshot,
    now = Date.now(),
  ): Promise<ExtractionResult> {
    const key = this.extractionKey(snapshot);
    const entries = this.extractEntries(snapshot, now);

    if (this.synthesizer) {
      const episode = entries.find((entry) => entry.type === "episode");
      const lesson = entries.find((entry) => entry.type === "lesson");
      if (episode && lesson) {
        try {
          const synthesized = await this.synthesizer(episode);
          if (synthesized) {
            Object.assign(lesson, synthesized, { id: lesson.id });
          }
        } catch {
          // Synthesis is best-effort; keep the heuristic lesson.
        }
      }
    }

    return { entries, key };
  }

  extractEntries(snapshot: SessionSnapshot, now = Date.now()): MemoryEntry[] {
    const attempts = snapshot.attempts;
    const failures = attempts.filter((attempt) => attempt.outcome === "failure");
    const successes = attempts.filter(
      (attempt) => attempt.outcome === "success" && attempt.successScore >= 0.6,
    );
    const entries: MemoryEntry[] = [];

    if (!successes.length) {
      if (failures.length >= 2) {
        const avoid = this.buildAvoid(failures, null, snapshot, now);
        if (avoid) {
          entries.push(avoid);
        }
      }
      return entries;
    }

    const solution = successes[successes.length - 1];
    const related = failures.filter((failure) => sharesProblemFamily(failure, solution));
    const relevantFailures = related.length ? related : failures;
    if (!relevantFailures.length) {
      return entries;
    }

    const problem = relevantFailures[0];
    const errorSignature = problem.errorSignature ?? solution.errorSignature ?? null;
    const problemSignature = buildProblemSignature(
      problem.normalizedCommand,
      errorSignature,
    );
    const problemText = this.buildProblemText(problem, errorSignature);
    const appliesWhen = environmentConstraints(snapshot.environment);
    const doNotApplyWhen = environmentExclusions(snapshot.environment);
    const tags = unique([commandTool(problem.normalizedCommand), errorSignature ?? ""]);
    const sourceAttempts = [...relevantFailures, solution].slice(-10);
    const provenance = createProvenance(now, {
      sessionId: snapshot.sessionId,
      taskId: snapshot.taskId,
      command: solution.command,
      errorSignature,
      environmentKey: environmentKey(snapshot.environment),
      sourceAttemptIds: sourceAttempts.map((attempt) => attempt.id),
    });

    entries.push(
      createMemoryEntry({
        type: "episode",
        text: problemText,
        solution: solution.command,
        action: solution.normalizedCommand,
        environment: snapshot.environment,
        scope: createScope(snapshot.environment, solution.normalizedCommand, errorSignature),
        tags,
        successCount: 1,
        failureCount: relevantFailures.length,
        score: solution.successScore,
        sessionIds: [snapshot.sessionId],
        provenance,
        data: {
          problemSignature,
          errorSignature,
          attempts: sourceAttempts,
          appliesWhen,
          doNotApplyWhen,
          postcondition: solution.postconditionMet ? "confirmed" : undefined,
        },
        now,
      }),
    );

    if (solution.successScore >= 0.6) {
      entries.push(
        createMemoryEntry({
          type: "procedure",
          text: this.buildProcedureText(problem, errorSignature, snapshot.environment),
          solution: solution.command,
          action: solution.normalizedCommand,
          environment: snapshot.environment,
          scope: createScope(snapshot.environment, solution.normalizedCommand, errorSignature),
          tags,
          successCount: 1,
          failureCount: relevantFailures.length,
          score: solution.successScore,
          sessionIds: [snapshot.sessionId],
          provenance,
          data: {
            problemSignature,
            errorSignature,
            appliesWhen,
            doNotApplyWhen,
            sourceIds: relevantFailures.map((failure) => failure.normalizedCommand),
            postcondition: solution.postconditionMet ? "confirmed" : undefined,
          },
          now,
        }),
      );

      entries.push(
        createMemoryEntry({
          type: "lesson",
          text: problemText,
          solution: solution.command,
          action: solution.normalizedCommand,
          environment: snapshot.environment,
          scope: createScope(snapshot.environment, solution.normalizedCommand, errorSignature),
          tags,
          successCount: 1,
          failureCount: 0,
          score: solution.successScore,
          sessionIds: [snapshot.sessionId],
          provenance,
          data: {
            problemSignature,
            errorSignature,
            cause: describeError(errorSignature) || "причина не определена",
            appliesWhen,
            doNotApplyWhen,
          },
          now,
        }),
      );

      const avoid = this.buildAvoid(relevantFailures, problemSignature, snapshot, now);
      if (avoid) {
        entries.push(avoid);
      }
    }

    return entries;
  }

  /**
   * Semantic facts describing the current environment.
   *
   * Facts are keyed by their kind (`os`, `cwd`, `tools`, …) and carry their
   * values in `data`, so a re-observation merges into the existing entry instead
   * of forking a near-duplicate one. Multi-valued facts (`tools`) accumulate;
   * single-valued ones are replaced by the freshest observation. They are born
   * as `candidate`: an observed environment detail is not "trusted knowledge"
   * until real use confirms it.
   */
  environmentFacts(environment: EnvironmentSnapshot, now = Date.now()): MemoryEntry[] {
    const facts: Array<{
      kind: string;
      label: string;
      values: string[];
      mode: "replace" | "union";
    }> = [];

    if (environment.os) {
      facts.push({
        kind: "os",
        label: "ОС",
        values: [
          environment.osVersion
            ? `${environment.os} ${environment.osVersion}`
            : environment.os,
        ],
        mode: "replace",
      });
    }
    if (environment.shell) {
      facts.push({
        kind: "shell",
        label: "Оболочка терминала",
        values: [environment.shell],
        mode: "replace",
      });
    }
    if (environment.runtime) {
      facts.push({
        kind: "runtime",
        label: "Основной runtime",
        values: [environment.runtime],
        mode: "replace",
      });
    }
    if (environment.cwd) {
      facts.push({
        kind: "cwd",
        label: "Рабочая директория",
        values: [environment.cwd],
        mode: "replace",
      });
    }
    if (environment.cwdType) {
      facts.push({
        kind: "cwd_type",
        label: "Тип проекта",
        values: [environment.cwdType],
        mode: "replace",
      });
    }
    const tools = unique((environment.tools ?? []).filter(Boolean));
    if (tools.length) {
      facts.push({
        kind: "tools",
        label: "Используемые инструменты",
        values: tools.slice(0, 12),
        mode: "union",
      });
    }

    return facts.map((fact) =>
      createMemoryEntry({
        type: "fact",
        text: `${fact.label}: ${fact.values.join(", ")}`,
        environment,
        tags: ["environment"],
        successCount: 0,
        failureCount: 0,
        status: "candidate",
        data: {
          factKind: fact.kind,
          factLabel: fact.label,
          factValues: fact.values,
          factMode: fact.mode,
        },
        now,
      }),
    );
  }

  private buildProblemText(problem: CommandAttempt, errorSignature: string | null): string {
    const cause = describeError(errorSignature);
    const suffix = cause ? `: ${cause}` : "";
    return `Команда «${truncate(problem.command, 160)}» завершилась ошибкой${suffix}`;
  }

  private buildProcedureText(
    problem: CommandAttempt,
    errorSignature: string | null,
    environment: EnvironmentSnapshot,
  ): string {
    const constraints = environmentConstraints(environment).join(", ");
    const cause = describeError(errorSignature);
    const scope = constraints ? ` (${constraints})` : "";
    const suffix = cause ? `: ${cause}` : "";
    return `Команда «${truncate(problem.normalizedCommand, 140)}» падает${scope}${suffix}`;
  }

  private buildAvoid(
    failures: CommandAttempt[],
    problemSignature: string | null,
    snapshot: SessionSnapshot,
    now: number,
  ): MemoryEntry | null {
    const commands = unique(failures.map((failure) => failure.command.trim()).filter(Boolean));
    const errorSignature = failures[failures.length - 1]?.errorSignature ?? null;
    const avoid = unique([...commands, ...errorAdvice(errorSignature)]).slice(0, 8);
    if (!avoid.length) {
      return null;
    }
    const first = failures[0];
    const provenance = createProvenance(now, {
      sessionId: snapshot.sessionId,
      taskId: snapshot.taskId,
      command: first.command,
      errorSignature,
      environmentKey: environmentKey(snapshot.environment),
      sourceAttemptIds: failures.map((attempt) => attempt.id),
    });
    return createMemoryEntry({
      type: "avoid",
      text: this.buildProblemText(first, errorSignature),
      environment: snapshot.environment,
      scope: createScope(snapshot.environment, first.normalizedCommand, errorSignature),
      tags: ["avoid", errorSignature ?? ""].filter(Boolean),
      successCount: 0,
      failureCount: failures.length,
      sessionIds: [snapshot.sessionId],
      provenance,
      data: {
        problemSignature:
          problemSignature ??
          buildProblemSignature(first.normalizedCommand, first.errorSignature),
        errorSignature,
        avoid,
      },
      now,
    });
  }
}
