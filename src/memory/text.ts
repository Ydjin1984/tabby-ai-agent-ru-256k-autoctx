/**
 * Text, command and error-signature helpers.
 *
 * Embeddings here are a deterministic, dependency-free hashed bag-of-features
 * vector. They are not as good as a real embedding model, but they work fully
 * offline, are stable across runs and are more than enough to route "similar
 * problem" queries to the right past experience. A remote embedding provider
 * can be plugged in later without touching the rest of the layer.
 */

import { CommandOutcome } from "./types";

export const EMBEDDING_DIM = 192;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "you",
  "your",
  "not",
  "but",
  "can",
  "will",
  "get",
  "got",
  "use",
  "using",
  "into",
  "when",
  "then",
  "than",
  "из",
  "или",
  "для",
  "что",
  "это",
  "как",
  "так",
  "при",
  "без",
  "над",
  "под",
  "уже",
  "ещё",
  "еще",
  "если",
  "чем",
  "был",
  "была",
  "были",
  "есть",
  "надо",
  "нужно",
  "чтобы",
]);

/** FNV-1a 32-bit hash; stable across processes. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function normalizeWhitespace(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Strip prompt decoration from a command line so `PS C:\x> pip install a` and
 * `pip install a` produce the same signature.
 */
export function normalizeCommand(command: string): string {
  let value = (command ?? "").trim();
  value = value.replace(/^[^\s]*[#$>%]\s+/, "");
  value = value.replace(/\s+/g, " ");
  return value;
}

export function commandSignature(command: string): string {
  return normalizeCommand(command).toLowerCase();
}

/** First meaningful token of a command, e.g. `py` for `py -m pip install x`. */
export function commandTool(command: string): string {
  const normalized = normalizeCommand(command).toLowerCase();
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  // Skip common launchers so `py -m pip` is attributed to `pip`.
  if ((tokens[0] === "py" || tokens[0] === "python" || tokens[0] === "python3") && tokens[1] === "-m") {
    return tokens[2] ?? tokens[0];
  }
  return tokens[0].replace(/\.(cmd|exe|ps1|bat)$/i, "");
}

export function tokenize(text: string): string[] {
  if (!text) {
    return [];
  }
  const raw = text
    .toLowerCase()
    .split(/[^a-z\u0430-\u044f0-9_./\\:-]+/i)
    .filter(Boolean);
  const tokens: string[] = [];
  for (const token of raw) {
    if (token.length < 2 || STOPWORDS.has(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function charNGrams(token: string, size: number): string[] {
  if (token.length <= size) {
    return [];
  }
  const grams: string[] = [];
  for (let i = 0; i + size <= token.length; i++) {
    grams.push(token.slice(i, i + size));
  }
  return grams;
}

function addFeature(vector: number[], feature: string, weight: number, dim: number): void {
  const hash = fnv1a(feature);
  const index = hash % dim;
  const sign = hash & 0x80000000 ? -1 : 1;
  vector[index] += sign * weight;
}

function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    return vector;
  }
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= norm;
  }
  return vector;
}

/** Deterministic hashed embedding of a piece of text. */
export function embedText(text: string, dim = EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  const textTokens = tokenize(text);
  for (const token of textTokens) {
    addFeature(vector, token, 1, dim);
    for (const gram of charNGrams(token, 3)) {
      addFeature(vector, gram, 0.4, dim);
    }
  }
  return l2Normalize(vector);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Vectors are L2-normalized, so the dot product is the cosine.
  return Math.max(0, Math.min(1, dot));
}

export function jaccardSimilarity(a: string[] | Set<string>, b: string[] | Set<string>): number {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Lexical fallback used when an embedding is missing. */
export function lexicalSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenize(a), tokenize(b));
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function truncate(text: string, maxChars: number): string {
  const value = text ?? "";
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n... (truncated)`;
}

export interface ErrorSignatureMatch {
  signature: string;
  cause: string;
  advice: string[];
}

const ERROR_SIGNATURES: Array<{
  signature: string;
  cause: string;
  advice: string[];
  patterns: RegExp[];
}> = [
  {
    signature: "powershell_execution_policy",
    cause: "PowerShell блокирует выполнение .ps1-скриптов (execution policy).",
    advice: ["запускать .ps1 напрямую", "переустанавливать Node/pnpm"],
    patterns: [
      /execution of scripts is disabled/i,
      /running scripts is disabled/i,
      /UnauthorizedAccess/i,
    ],
  },
  {
    signature: "command_not_found",
    cause: "Команда не найдена в PATH.",
    advice: ["повторять ту же команду без изменения PATH"],
    patterns: [
      /command not found/i,
      /is not recognized as an internal or external command/i,
      /is not recognized as the name of a cmdlet/i,
      /: not found$/im,
    ],
  },
  {
    signature: "module_not_found",
    cause: "Модуль или пакет не установлен.",
    advice: [],
    patterns: [/ModuleNotFoundError/i, /Cannot find module/i, /No module named/i],
  },
  {
    signature: "permission_denied",
    cause: "Недостаточно прав для операции.",
    advice: ["повторять без запроса прав/администратора"],
    patterns: [/\bEACCES\b/, /permission denied/i, /Access is denied/i],
  },
  {
    signature: "enoent",
    cause: "Файл или путь не существует.",
    advice: [],
    patterns: [/\bENOENT\b/, /No such file or directory/i],
  },
  {
    signature: "network",
    cause: "Сетевая ошибка или недоступен хост.",
    advice: ["повторять запрос без изменения сети"],
    patterns: [
      /\bECONNREFUSED\b/,
      /\bETIMEDOUT\b/,
      /Could not resolve host/i,
      /Connection refused/i,
      /Temporary failure in name resolution/i,
    ],
  },
  {
    signature: "auth",
    cause: "Ошибка аутентификации или токена.",
    advice: [],
    patterns: [/\b401\b/, /\b403\b/, /Unauthorized/i, /authentication failed/i],
  },
  {
    signature: "npm_err",
    cause: "Ошибка пакетного менеджера npm.",
    advice: [],
    patterns: [/npm ERR!/, /\bERR!\b/],
  },
  {
    signature: "python_traceback",
    cause: "Исключение в Python-скрипте.",
    advice: [],
    patterns: [/Traceback \(most recent call last\)/i],
  },
];

/** Ordered signature extraction; the first matching rule wins. */
export function extractErrorSignature(output: string): string | null {
  const text = output ?? "";
  if (!text.trim()) {
    return null;
  }
  for (const rule of ERROR_SIGNATURES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return rule.signature;
    }
  }
  if (/\b(fatal|error|failed)\b\s*[:!]/i.test(text) || /^\s*error[:\s]/im.test(text)) {
    return "generic_error";
  }
  return null;
}

export function describeError(signature: string | null | undefined): string {
  if (!signature) {
    return "";
  }
  const rule = ERROR_SIGNATURES.find((item) => item.signature === signature);
  if (rule) {
    return rule.cause;
  }
  return signature === "generic_error" ? "Неизвестная ошибка выполнения." : signature;
}

export function errorAdvice(signature: string | null | undefined): string[] {
  if (!signature) {
    return [];
  }
  const rule = ERROR_SIGNATURES.find((item) => item.signature === signature);
  return rule ? [...rule.advice] : [];
}

/**
 * Heuristic failure detection. Deliberately conservative: a command is only
 * marked as failed when the output carries a recognisable error marker, so
 * ordinary successful commands are never demoted.
 */
export function isFailureOutput(output: string): boolean {
  const text = output ?? "";
  if (!text.trim()) {
    return false;
  }
  return ERROR_SIGNATURES.some((rule) => rule.patterns.some((pattern) => pattern.test(text)))
    || /\b(fatal|error|failed)\b\s*[:!]/i.test(text)
    || /^\s*error[:\s]/im.test(text);
}

export function classifyOutcome(output: string): CommandOutcome {
  const text = output ?? "";
  if (!text.trim()) {
    return "unknown";
  }
  return isFailureOutput(text) ? "failure" : "success";
}

/** True when the same error signature (or the same leading tool) is involved. */
export function sharesProblemFamily(
  a: { normalizedCommand: string; errorSignature?: string | null },
  b: { normalizedCommand: string; errorSignature?: string | null },
): boolean {
  if (a.errorSignature && b.errorSignature && a.errorSignature === b.errorSignature) {
    return true;
  }
  const toolA = commandTool(a.normalizedCommand);
  const toolB = commandTool(b.normalizedCommand);
  if (toolA && toolB && toolA === toolB) {
    return true;
  }
  return lexicalSimilarity(a.normalizedCommand, b.normalizedCommand) >= 0.4;
}

/**
 * Prefix-based action match: `npm install` and `npm install foo` are the same
 * procedure, while `npm install` and `npm publish` are not.
 */
export function commandMatchesAction(command: string, action: string): boolean {
  const left = commandSignature(command).split(" ").filter(Boolean);
  const right = commandSignature(action).split(" ").filter(Boolean);
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left.join(" ") === right.join(" ")) {
    return true;
  }
  const prefixLength = Math.min(3, left.length, right.length);
  for (let i = 0; i < prefixLength; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

export function buildProblemSignature(command: string, errorSignature: string | null): string {
  const tool = commandTool(command);
  const error = errorSignature ?? "unknown_error";
  return `${tool}|${error}`;
}
