/**
 * Файловый лог агента.
 *
 * Рантайм-логи плагина пишутся в консоль Electron-рендерера и нигде не
 * сохраняются, поэтому диагностировать постфактум невозможно. Этот модуль
 * добавляет простой append-only лог в `~/.tabby-ai-agent/agent.log`:
 * параметры запроса, вызовы инструментов, причины завершения и ошибки.
 *
 * Логирование никогда не должно ломать чат: любая ошибка записи отключает лог.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const LOG_DIR = path.join(os.homedir(), ".tabby-ai-agent");
const LOG_FILE = path.join(LOG_DIR, "agent.log");
const MAX_BYTES = 2_000_000;
const MAX_VALUE_CHARS = 2000;

let disabled = false;

function ensureDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // каталог уже есть или недоступен
  }
}

function safeString(data: unknown): string {
  try {
    if (data === undefined) return "";
    if (typeof data === "string") return data;
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_CHARS
    ? `${text.slice(0, MAX_VALUE_CHARS)}…(+${text.length - MAX_VALUE_CHARS})`
    : text;
}

/** Добавляет строку в лог. `event` — короткий тег, `data` — произвольные детали. */
export function agentLog(event: string, data?: unknown): void {
  if (disabled) {
    return;
  }
  try {
    ensureDir();
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_BYTES) {
        fs.writeFileSync(LOG_FILE, "", "utf8");
      }
    } catch {
      // файла ещё нет
    }
    const details = data === undefined ? "" : ` ${truncate(safeString(data))}`;
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${event}${details}\n`, "utf8");
  } catch {
    disabled = true;
  }
}

/** Путь к файлу лога (для подсказки пользователю). */
export function agentLogPath(): string {
  return LOG_FILE;
}
