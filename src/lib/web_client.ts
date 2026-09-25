/**
 * Веб-доступ для инструментов агента: поиск DuckDuckGo без API-ключа и чтение
 * страниц.
 *
 * Сеть идёт через нативные модули Node (`http`/`https`), а не через браузерный
 * `fetch`: так запросы не зависят от CORS Electron-рендерера и работают из панели
 * так же, как запросы к LLM-эндпоинту.
 */

import * as http from "http";
import * as https from "https";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const DEFAULT_WEB_SEARCH_RESULTS = 6;
export const DEFAULT_DEEP_SEARCH_PAGES = 6;
export const DEFAULT_WEB_TIMEOUT_MS = 8000;
export const DEFAULT_WEB_CHAR_LIMIT = 4000;

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebToolsConfig {
  maxResults(): number;
  maxPages(): number;
  timeoutMs(): number;
  charLimit(): number;
}

export interface HttpRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  finalUrl: string;
}

export interface FetchedPage {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  middot: "\u00b7",
  bull: "\u2022",
  deg: "\u00b0",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  times: "\u00d7",
  divide: "\u00f7",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

function fromCodePointSafe(codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

/** Раскрывает именованные и числовые HTML-сущности. */
export function decodeHtmlEntities(text: string): string {
  return String(text ?? "").replace(
    /&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi,
    (full: string, code: string) => {
      const key = code.toLowerCase();
      if (key.startsWith("#x")) {
        return fromCodePointSafe(parseInt(key.slice(2), 16)) || full;
      }
      if (key.startsWith("#")) {
        return fromCodePointSafe(parseInt(key.slice(1), 10)) || full;
      }
      return HTML_ENTITIES[key] ?? full;
    },
  );
}

/** Убирает теги и лишние пробелы, оставляя плоский текст. */
export function stripHtml(html: string): string {
  return decodeHtmlEntities(
    String(html ?? "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Преобразует HTML в читаемый текст, сохраняя переносы абзацев и списков. */
export function htmlToText(html: string): string {
  const withoutNoise = String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const withBreaks = withoutNoise
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]*>/g, " ");

  return decodeHtmlEntities(withBreaks)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Заголовок страницы из `<title>`. */
export function extractTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""));
  return match ? stripHtml(match[1]) : "";
}

/** `//duckduckgo.com/l/?uddg=...` → реальный URL результата. */
export function decodeDuckDuckGoUrl(href: string): string {
  const raw = decodeHtmlEntities(String(href ?? "").trim());
  if (!raw) {
    return "";
  }
  const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(absolute);
    const host = url.hostname.toLowerCase();
    if (
      (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) &&
      url.pathname.startsWith("/l/")
    ) {
      const target = url.searchParams.get("uddg");
      if (target) {
        return target;
      }
    }
    return url.toString();
  } catch {
    return absolute;
  }
}

/** Добавляет https://, если схема не указана. */
export function normalizeHttpUrl(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (/^\/\//.test(value)) {
    return `https:${value}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }
  return `https://${value}`;
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((part) => part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) {
    return false;
  }
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("::ffff:")) {
    return isPrivateIpv4(value.slice("::ffff:".length));
  }
  return false;
}

/**
 * Разрешает только публичные http(s)-адреса: защита от SSRF, когда URL
 * предлагает модель.
 */
export function isSafePublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (!host) {
    return false;
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  ) {
    return false;
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return false;
  }
  return true;
}

function requestOnce(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Некорректный URL: ${url}`));
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const limit = options.maxBytes ?? MAX_RESPONSE_BYTES;
    const req = transport.request(
      parsed,
      {
        method: options.method ?? "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "ru,en;q=0.8",
          "Accept-Encoding": "identity",
          ...(options.headers ?? {}),
        },
        timeout: options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > limit) {
            const keep = chunk.length - (total - limit);
            if (keep > 0) {
              chunks.push(chunk.subarray(0, keep));
            }
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            finalUrl: url,
          });
        });
        res.on("error", reject);
      },
    );

    const onAbort = () => req.destroy(new DOMException("Operation was aborted.", "AbortError"));
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    req.on("timeout", () => req.destroy(new Error("Превышено время ожидания запроса.")));
    req.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/** HTTP-запрос с поддержкой редиректов, таймаута и лимита размера. */
export async function httpRequest(
  rawUrl: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  let currentUrl = rawUrl;
  let method = options.method ?? "GET";
  let body = options.body;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSafePublicUrl(currentUrl)) {
      throw new Error("Запрещённый адрес: разрешены только публичные http(s)-ресурсы.");
    }
    const response = await requestOnce(currentUrl, { ...options, method, body });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) {
        return response;
      }
      currentUrl = new URL(location, currentUrl).toString();
      if (response.status === 303) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return response;
  }
  throw new Error("Слишком много перенаправлений.");
}

/**
 * Разбирает страницу результатов DuckDuckGo (html-версия и lite) в список
 * результатов. Парсинг на регулярных выражениях: не требует DOM и работает
 * одинаково в Electron и в Node-тестах.
 */
export function parseDuckDuckGo(html: string, maxResults: number): WebSearchResult[] {
  const source = String(html ?? "");
  if (!source) {
    return [];
  }

  const anchors: Array<{ end: number; title: string; url: string }> = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(source)) !== null) {
    const attrs = match[1] ?? "";
    const className = /class\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    if (!/\bresult__a\b/.test(className) && !/\bresult-link\b/.test(className)) {
      continue;
    }
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    const url = decodeDuckDuckGoUrl(href);
    const title = stripHtml(match[2] ?? "");
    if (!url || !title) {
      continue;
    }
    anchors.push({ end: match.index + match[0].length, title, url });
  }

  const snippets: Array<{ start: number; text: string }> = [];
  const snippetRe =
    /class\s*=\s*["'][^"']*result[^"']*snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td)>/gi;
  while ((match = snippetRe.exec(source)) !== null) {
    const text = stripHtml(match[1] ?? "");
    if (text) {
      snippets.push({ start: match.index, text });
    }
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    if (results.length >= maxResults) {
      break;
    }
    if (seen.has(anchor.url)) {
      continue;
    }
    seen.add(anchor.url);
    const snippet = snippets.find((item) => item.start > anchor.end)?.text ?? "";
    results.push({ title: anchor.title, url: anchor.url, snippet });
  }
  return results;
}

export interface DuckDuckGoSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Поиск в DuckDuckGo. Основной эндпоинт — POST `html.duckduckgo.com/html/`
 * (GET отдаёт страницу проверки «anomaly»), резервный — `lite.duckduckgo.com`.
 */
export async function duckduckgoSearch(
  query: string,
  options: DuckDuckGoSearchOptions = {},
): Promise<WebSearchResult[]> {
  const cleanQuery = String(query ?? "").trim();
  if (!cleanQuery) {
    return [];
  }

  const maxResults = Math.max(1, Math.min(20, Math.floor(options.maxResults ?? DEFAULT_WEB_SEARCH_RESULTS)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  const endpoints = [
    "https://html.duckduckgo.com/html/",
    "https://lite.duckduckgo.com/lite/",
  ];

  let lastError: Error | null = null;
  for (const endpoint of endpoints) {
    if (options.signal?.aborted) {
      throw new DOMException("Operation was aborted.", "AbortError");
    }
    try {
      const body = new URLSearchParams({ q: cleanQuery, b: "" }).toString();
      const response = await httpRequest(endpoint, {
        method: "POST",
        body,
        timeoutMs,
        signal: options.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (response.status >= 400) {
        lastError = new Error(`DuckDuckGo ответил HTTP ${response.status}.`);
        continue;
      }
      const html = response.body;
      const hasResults = /result__a|result-link/i.test(html);
      if (!hasResults && /anomaly/i.test(html)) {
        lastError = new Error("DuckDuckGo запросил проверку (anomaly); попробуйте позже.");
        continue;
      }
      const results = parseDuckDuckGo(html, maxResults);
      if (results.length) {
        return results;
      }
      lastError = new Error("DuckDuckGo не вернул результатов.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Поиск в DuckDuckGo не удался.");
}

export interface FetchPageOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  charLimit?: number;
}

/** Скачивает страницу и возвращает её заголовок и читаемый текст. */
export async function fetchPageText(
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  const url = normalizeHttpUrl(rawUrl);
  if (!url) {
    throw new Error("Пустой URL.");
  }
  if (!isSafePublicUrl(url)) {
    throw new Error("Ссылка ведёт на локальный или служебный адрес — запрещено.");
  }

  const response = await httpRequest(url, {
    timeoutMs: options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
    signal: options.signal,
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
    },
  });
  if (response.status >= 400) {
    throw new Error(`Сервер вернул HTTP ${response.status}.`);
  }

  const contentType = String(response.headers["content-type"] ?? "");
  const looksLikeText =
    !contentType ||
    contentType.includes("text") ||
    contentType.includes("json") ||
    contentType.includes("xml");
  if (!looksLikeText) {
    throw new Error(`Неподдерживаемый тип содержимого: ${contentType}.`);
  }

  const html = response.body;
  const isHtml = contentType.includes("html") || /<html|<body|<div|<p\b/i.test(html);
  const text = isHtml ? htmlToText(html) : html.trim();
  const limit = options.charLimit ?? DEFAULT_WEB_CHAR_LIMIT;
  const truncated = text.length > limit;

  let host = response.finalUrl;
  try {
    host = new URL(response.finalUrl).hostname;
  } catch {
    // оставляем полный URL
  }

  return {
    title: extractTitle(html) || host,
    url: response.finalUrl,
    text: truncated ? `${text.slice(0, limit)}\u2026` : text,
    truncated,
  };
}

/** Человекочитаемая выдача результатов поиска (идёт и модели, и в панель). */
export function formatSearchResults(query: string, results: WebSearchResult[]): string {
  const lines: string[] = [
    `Результаты поиска по запросу «${query}» — найдено ${results.length}:`,
    "",
  ];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   URL: ${result.url}`);
    if (result.snippet) {
      lines.push(`   ${result.snippet}`);
    }
    lines.push("");
  });
  return lines.join("\n").trim();
}
