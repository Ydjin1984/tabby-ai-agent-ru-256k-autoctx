import { inflateSync } from "zlib";

/** Сколько символов одного вложения кладём в запрос модели. */
export const ATTACHMENT_TEXT_LIMIT = 60_000;

export function looksLikeText(text: string): boolean {
  if (!text) {
    return false;
  }
  const sample = text.slice(0, 4000);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) {
      return false;
    }
    if (code < 9 || (code > 13 && code < 32)) {
      bad += 1;
    }
  }
  return bad / sample.length < 0.08;
}

export function clipAttachmentText(
  text: string,
  limit = ATTACHMENT_TEXT_LIMIT,
): { text: string; clipped: boolean } {
  if (text.length <= limit) {
    return { text, clipped: false };
  }
  const marker = "\n… [середина файла опущена, в контексте начало и конец] …\n";
  if (limit <= marker.length + 2) {
    return { text: text.slice(0, limit), clipped: true };
  }
  const head = Math.floor((limit - marker.length) * 0.65);
  const tail = limit - marker.length - head;
  return {
    text: text.slice(0, head) + marker + text.slice(text.length - tail),
    clipped: true,
  };
}

function unescapePdfLiteral(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\(\d{1,3})/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
}

function stringsFromPdfBytes(bytes: Buffer): string[] {
  const source = bytes.toString("latin1");
  const found: string[] = [];
  const re = /\(((?:\\.|[^\\)]){2,400})\)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const text = unescapePdfLiteral(match[1]).replace(/\s+/g, " ").trim();
    if (looksLikeText(text)) {
      found.push(text);
    }
  }
  return found;
}

/**
 * Достаёт видимый текст из PDF: несжатые строки и потоки FlateDecode.
 * Скан без текстового слоя вернёт пустую строку.
 */
export function extractPdfText(data: Uint8Array): string {
  const bytes = Buffer.from(data);
  const pieces = stringsFromPdfBytes(bytes);
  const source = bytes.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(source)) !== null) {
    const start = match.index - 200;
    const header = source.slice(Math.max(0, start), match.index);
    if (!/FlateDecode/.test(header)) {
      continue;
    }
    try {
      const inflated = inflateSync(Buffer.from(match[1], "latin1"));
      pieces.push(...stringsFromPdfBytes(inflated));
    } catch {
      // Битый или не-zlib поток — пропускаем.
    }
  }
  return pieces.join("\n").trim();
}
