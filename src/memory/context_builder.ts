/**
 * Context Builder — turn retrieved memories into a compact prompt block.
 *
 * This is the most important seam of the whole layer: the model never sees the
 * raw memory database, only a short, structured decision digest inserted right
 * before the user's message. Each memory is rendered as a situation with its
 * environment, previously failed/successful commands, success stats, lifecycle
 * status and an explicit recommendation — not as a raw JSON snippet.
 */

import { EnvironmentSnapshot, MemoryEntry, RankedMemory } from "./types";
import { SessionSnapshot } from "./session_memory";
import { describeEnvironment } from "./environment";
import { estimateTokenCount } from "../lib/context_usage";
import { truncate, unique } from "./text";

export const DEFAULT_MEMORY_CONTEXT_TOKENS = 1200;

export interface MemoryContextInput {
  environment: EnvironmentSnapshot;
  session: SessionSnapshot;
  memories: RankedMemory[];
  tokenBudget?: number;
}

export function buildMemoryContext(input: MemoryContextInput): string | null {
  const budget = input.tokenBudget ?? DEFAULT_MEMORY_CONTEXT_TOKENS;
  const sections: string[] = [];

  const header: string[] = ["## Память агента (накопленный опыт)"];
  const envLine = describeEnvironment(input.environment);
  const goal = input.session.goal || input.session.lastUserMessage;
  if (envLine) {
    header.push(`Окружение: ${envLine}`);
  }
  if (goal) {
    header.push(`Текущая задача: ${truncate(goal, 240)}`);
  }

  const failedCommands = unique(
    input.session.attempts
      .filter((attempt) => attempt.outcome === "failure")
      .map((attempt) => attempt.command.trim())
      .filter(Boolean),
  );
  if (failedCommands.length) {
    header.push(
      `Уже пробовали без успеха: ${failedCommands
        .slice(-5)
        .map((command) => `\`${truncate(command, 120)}\``)
        .join(", ")}`,
    );
  }

  if (header.length > 1) {
    sections.push(header.join("\n"));
  }

  appendSection(sections, "### Проверенные процедуры", input.memories, "procedure", budget);
  appendSection(sections, "### Похожий прошлый опыт", input.memories, "episode", budget);
  appendSection(sections, "### Уроки", input.memories, "lesson", budget);
  appendSection(sections, "### Что известно об окружении", input.memories, "fact", budget);
  appendSection(sections, "### Чего избегать", input.memories, "avoid", budget);

  if (sections.length === 0) {
    return null;
  }

  const text = sections.join("\n\n").trim();
  return text || null;
}

function appendSection(
  sections: string[],
  title: string,
  memories: RankedMemory[],
  type: MemoryEntry["type"],
  budget: number,
): void {
  const items = memories.filter((memory) => memory.entry.type === type);
  if (!items.length) {
    return;
  }

  const blocks: string[] = [title];
  for (const item of items) {
    const block = formatMemoryBlock(item);
    if (!block) {
      continue;
    }
    const candidate = [...sections, [...blocks, block].join("\n\n")].join("\n\n");
    if (estimateTokenCount(candidate) > budget) {
      break;
    }
    blocks.push(block);
  }

  if (blocks.length > 1) {
    sections.push(blocks.join("\n\n"));
  }
}

function formatMemoryBlock(item: RankedMemory): string | null {
  const entry = item.entry;
  switch (entry.type) {
    case "procedure":
      return formatProcedure(item);
    case "episode":
      return formatEpisode(item);
    case "lesson":
      return formatLesson(item);
    case "avoid":
      return formatAvoid(item);
    case "fact":
    default:
      return `- ${truncate(entry.text, 220)}`;
  }
}

function formatProcedure(item: RankedMemory): string {
  const entry = item.entry;
  const lines: string[] = [];
  lines.push(`Проблема: ${truncate(entry.text, 220)}`);
  lines.push(environmentLine(entry));

  const failed = failedCommandsOf(entry);
  if (failed.length) {
    lines.push(`Раньше не сработало: ${failed.map(code).join(", ")}`);
  }
  if (entry.solution || entry.action) {
    lines.push(`Сработало: ${code(entry.solution || entry.action)}`);
  }

  const total = entry.successCount + entry.failureCount;
  lines.push(
    `Успех: ${entry.successCount}/${total || entry.successCount} · уверенность ${entry.confidence.toFixed(
      2,
    )} · статус ${statusLabel(entry.status)}`,
  );
  lines.push(`Рекомендация: предпочесть ${code(entry.solution || entry.action)}`);

  const avoid = (entry.data.doNotApplyWhen ?? [])
    .slice(0, 4)
    .map((value) => `\`${value}\``)
    .join(", ");
  if (avoid) {
    lines.push(`Не применять: ${avoid}`);
  }
  return lines.join("\n");
}

function formatEpisode(item: RankedMemory): string {
  const entry = item.entry;
  const lines: string[] = [];
  lines.push(`Проблема: ${truncate(entry.text, 200)}`);
  lines.push(environmentLine(entry));
  const failed = failedCommandsOf(entry);
  if (failed.length) {
    lines.push(`Раньше не сработало: ${failed.map(code).join(", ")}`);
  }
  if (entry.solution || entry.action) {
    lines.push(`Сработало: ${code(entry.solution || entry.action)}`);
  }
  return lines.join("\n");
}

function formatLesson(item: RankedMemory): string {
  const entry = item.entry;
  const lines: string[] = [];
  lines.push(`Проблема: ${truncate(entry.text, 200)}`);
  if (entry.data.cause) {
    lines.push(`Причина: ${truncate(entry.data.cause, 180)}`);
  }
  if (entry.solution || entry.action) {
    lines.push(`Решение: ${code(entry.solution || entry.action)}`);
  }
  const applies = (entry.data.appliesWhen ?? []).join(", ");
  const avoid = (entry.data.doNotApplyWhen ?? []).join(", ");
  if (applies) {
    lines.push(`Применимо: ${applies}`);
  }
  if (avoid) {
    lines.push(`Не применять: ${avoid}`);
  }
  return lines.join("\n");
}

function formatAvoid(item: RankedMemory): string | null {
  const entry = item.entry;
  const avoid = (entry.data.avoid ?? []).slice(0, 5).map(code);
  if (!avoid.length) {
    return null;
  }
  const scope = entry.scope;
  const scopeLine = [
    scope.tool ? `tool=${scope.tool}` : "",
    scope.errorSignature ? `error=${scope.errorSignature}` : "",
    scope.os ? `os=${scope.os}` : "",
    scope.shell ? `shell=${scope.shell}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `Триггер: ${truncate(entry.text, 200)}`,
    `Не повторяй: ${avoid.join(", ")}`,
  ];
  if (scopeLine) {
    lines.push(`Область: ${scopeLine}`);
  }
  return lines.join("\n");
}

function environmentLine(entry: MemoryEntry): string {
  const match = entry.environment;
  const parts: string[] = [];
  if (match.os) {
    parts.push(match.os);
  }
  if (match.shell) {
    parts.push(match.shell);
  }
  if (match.runtime) {
    parts.push(`runtime=${match.runtime}`);
  }
  return `Окружение: ${parts.join(" / ") || "не указано"}`;
}

function failedCommandsOf(entry: MemoryEntry): string[] {
  return unique(
    (entry.data.attempts ?? [])
      .filter((attempt) => attempt.outcome === "failure")
      .map((attempt) => attempt.command.trim())
      .filter(Boolean),
  ).slice(0, 4);
}

function code(value: string): string {
  return `\`${truncate(value, 140)}\``;
}

function statusLabel(status: MemoryEntry["status"]): string {
  switch (status) {
    case "trusted":
      return "trusted";
    case "validated":
      return "validated";
    case "superseded":
      return "superseded";
    case "candidate":
    default:
      return "candidate";
  }
}
