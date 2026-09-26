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
export const DEFAULT_WEB_TIMEOUT_MS = 15000;
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
  /** Выбранный движок поиска (id из WEB_SEARCH_ENGINES). */
  provider(): string;
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

/**
 * Разбирает выдачу Brave Search (статический HTML). Резервный движок на случай,
 * когда DuckDuckGo отдаёт bot-проверку/403.
 */
export function parseBraveResults(html: string, maxResults: number): WebSearchResult[] {
  const source = String(html ?? "");
  if (!source) {
    return [];
  }

  const titles: Array<{ index: number; end: number; title: string }> = [];
  const titleRe =
    /class="title search-snippet-title[^"]*"\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = titleRe.exec(source)) !== null) {
    const title = decodeHtmlEntities((match[1] || match[2] || "").trim());
    if (title) {
      titles.push({ index: match.index, end: match.index + match[0].length, title });
    }
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < titles.length && results.length < maxResults; i++) {
    const current = titles[i];
    const before = source.slice(Math.max(0, current.index - 1500), current.index);
    const hrefRe = /<a\b[^>]*href="(https?:\/\/[^"]+)"/gi;
    let href: RegExpExecArray | null;
    let url = "";
    while ((href = hrefRe.exec(before)) !== null) {
      url = href[1];
    }
    if (!url || seen.has(url)) {
      continue;
    }
    let after = source.slice(
      current.end,
      titles[i + 1] ? titles[i + 1].index : current.end + 2500,
    );
    // Drop the start of the next result block (its opening tag is not closed
    // inside this slice, so stripHtml would leave it as text).
    const nextBlock = after.indexOf('<div class="snippet');
    if (nextBlock >= 0) {
      after = after.slice(0, nextBlock);
    }
    const snippetMatch =
      /class="generic-snippet[^"]*"[^>]*>([\s\S]*?)(?=data-type="web"|<\/section>|$)/i.exec(
        after,
      );
    const snippet = stripHtml(snippetMatch ? snippetMatch[1] : after).slice(0, 280);
    seen.add(url);
    results.push({ title: current.title, url, snippet });
  }
  return results;
}

function mwmblText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "value" in part) {
        return String((part as { value?: unknown }).value ?? "");
      }
      return "";
    })
    .join("");
}

/**
 * Разбирает JSON индекса Mwmbl (`/api/v1/search`). Заголовок и сниппет там —
 * массивы фрагментов `{ value }`, а не строки.
 */
export function parseMwmbl(payload: string, maxResults: number): WebSearchResult[] {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (results.length >= maxResults || !item || typeof item !== "object") {
      break;
    }
    const record = item as { url?: unknown; title?: unknown; extract?: unknown };
    const url = String(record.url ?? "").trim();
    const title = mwmblText(record.title).replace(/\s+/g, " ").trim();
    const snippet = mwmblText(record.extract).replace(/\s+/g, " ").trim().slice(0, 280);
    if (!title || !isSafePublicUrl(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    results.push({ title, url, snippet });
  }
  return results;
}

/** Ссылка Bing `/ck/a?u=a1<base64>` → настоящий адрес результата. */
export function decodeBingUrl(href: string): string {
  const raw = decodeHtmlEntities(String(href ?? "").trim());
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw);
    if (url.hostname.endsWith("bing.com") && url.pathname.startsWith("/ck/")) {
      const token = url.searchParams.get("u") ?? "";
      const decoded = Buffer.from(token.replace(/^a1/, ""), "base64").toString("utf8");
      if (isSafePublicUrl(decoded)) {
        return decoded;
      }
    }
    return isSafePublicUrl(url.toString()) ? url.toString() : "";
  } catch {
    return "";
  }
}

/** Разбирает органическую выдачу Bing (`li.b_algo`), если страница её содержит. */
export function parseBingResults(html: string, maxResults: number): WebSearchResult[] {
  const source = String(html ?? "");
  if (!source || /there are no results for/i.test(source)) {
    return [];
  }
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const blocks = source.split(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= maxResults) {
      break;
    }
    const link = /<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) {
      continue;
    }
    const url = decodeBingUrl(link[1]);
    const title = stripHtml(link[2]);
    if (!url || !title || seen.has(url)) {
      continue;
    }
    const snippetMatch = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = stripHtml(snippetMatch?.[1] ?? "").slice(0, 280);
    seen.add(url);
    results.push({ title, url, snippet });
  }
  return results;
}

export type WebSearchProviderId = "auto" | "duckduckgo" | "mwmbl" | "brave";

export interface WebSearchEngineInfo {
  id: WebSearchProviderId;
  label: string;
  description: string;
}

/** Выбираемые поисковые движки (показываются в меню «Поиск»). */
export const WEB_SEARCH_ENGINES: WebSearchEngineInfo[] = [
  { id: "auto", label: "Авто", description: "Несколько движков, пока один не ответит" },
  { id: "mwmbl", label: "Mwmbl", description: "Открытый индекс, без проверки браузера" },
  { id: "duckduckgo", label: "DuckDuckGo", description: "Без ключа; часто включает проверку" },
  { id: "brave", label: "Brave", description: "Запасной статический поиск" },
];

export function normalizeSearchProvider(id: unknown): WebSearchProviderId {
  return id === "duckduckgo" || id === "brave" || id === "mwmbl" ? id : "auto";
}

export function findWebSearchEngine(id: unknown): WebSearchEngineInfo {
  const normalized = normalizeSearchProvider(id);
  return (
    WEB_SEARCH_ENGINES.find((engine) => engine.id === normalized) ??
    WEB_SEARCH_ENGINES[0]
  );
}

export interface DuckDuckGoSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WebSearchOptions extends DuckDuckGoSearchOptions {
  provider?: WebSearchProviderId | string;
}

/** Пауза между поисковыми запросами, чтобы не устраивать залп в один движок. */
const SEARCH_GAP_MS = 400;
/** Сколько ждать DuckDuckGo. Дольше нет смысла: с этой сети он часто просто молчит. */
const DDG_ATTEMPT_MS = 4500;
/** После таймаута или проверки «anomaly» не трогаем DuckDuckGo пару минут. */
const DDG_COOLDOWN_MS = 2 * 60 * 1000;
/** Кэш одинаковых запросов: модель любит повторять один и тот же поиск. */
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
let ddgDownUntil = 0;
let searchChain: Promise<unknown> = Promise.resolve();
const searchCache = new Map<string, { at: number; results: WebSearchResult[] }>();

/** Один поисковый запрос за раз. Глубокий поиск иначе бьёт в движок пачкой и ловит проверку. */
function enqueueSearch<T>(job: () => Promise<T>): Promise<T> {
  const run = searchChain.then(job, job);
  searchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Operation was aborted.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function markDuckDuckGoDown(): void {
  ddgDownUntil = Date.now() + DDG_COOLDOWN_MS;
}

/**
 * Один проход DuckDuckGo: POST на html-выдачу и, если она пустая, GET lite.
 * Повторные круги с паузой только быстрее приводили к проверке «anomaly».
 */
async function runDuckDuckGo(
  cleanQuery: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  if (Date.now() < ddgDownUntil) {
    throw new Error("DuckDuckGo временно пропущен: недавно ответил проверкой или молчанием.");
  }
  const attemptMs = Math.min(timeoutMs, DDG_ATTEMPT_MS);
  const attempts: Array<() => Promise<HttpResponse>> = [
    () =>
      httpRequest("https://html.duckduckgo.com/html/", {
        method: "POST",
        body: new URLSearchParams({ q: cleanQuery, b: "" }).toString(),
        timeoutMs: attemptMs,
        signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html,application/xhtml+xml",
        },
      }),
    () =>
      httpRequest(
        `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(cleanQuery)}`,
        {
          timeoutMs: attemptMs,
          signal,
          headers: { Accept: "text/html,application/xhtml+xml" },
        },
      ),
  ];

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    if (signal?.aborted) {
      throw new DOMException("Operation was aborted.", "AbortError");
    }
    try {
      const response = await attempt();
      if (response.status >= 400) {
        lastError = new Error(`DuckDuckGo ответил HTTP ${response.status}.`);
        continue;
      }
      if (/anomaly/i.test(response.body) && !/result__a|result-link/i.test(response.body)) {
        lastError = new Error("DuckDuckGo запросил проверку (anomaly).");
        continue;
      }
      const results = parseDuckDuckGo(response.body, Math.max(maxResults, 20));
      if (results.length) {
        return results;
      }
      lastError = new Error("DuckDuckGo не вернул результатов.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      // Молчание — это обрыв маршрута, а не пустая выдача: второй хост ждать незачем.
      if (/ожидания|timeout/i.test(lastError.message)) {
        break;
      }
    }
  }
  markDuckDuckGoDown();
  throw lastError ?? new Error("DuckDuckGo не дал результатов.");
}

/** Открытый индекс Mwmbl: обычный JSON, без браузерной проверки. */
async function runMwmbl(
  cleanQuery: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const response = await httpRequest(
    `https://mwmbl.org/api/v1/search/?s=${encodeURIComponent(cleanQuery)}`,
    {
      timeoutMs: Math.min(timeoutMs, 8000),
      signal,
      headers: { Accept: "application/json" },
    },
  );
  if (response.status >= 400) {
    throw new Error(`Mwmbl ответил HTTP ${response.status}.`);
  }
  const results = parseMwmbl(response.body, Math.max(maxResults, 20));
  if (!results.length) {
    throw new Error("Mwmbl не вернул результатов.");
  }
  return results;
}

/** Bing HTML. Часто отдаёт пустую страницу-заглушку — тогда сразу идём дальше. */
async function runBing(
  cleanQuery: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const response = await httpRequest(
    `https://www.bing.com/search?q=${encodeURIComponent(cleanQuery)}&count=10`,
    {
      timeoutMs: Math.min(timeoutMs, 8000),
      signal,
      headers: { Accept: "text/html,application/xhtml+xml" },
    },
  );
  if (response.status >= 400) {
    throw new Error(`Bing ответил HTTP ${response.status}.`);
  }
  const results = parseBingResults(response.body, Math.max(maxResults, 20));
  if (!results.length) {
    throw new Error("Bing не вернул результатов.");
  }
  return results;
}

/** Brave Search: обычный статический HTML, парсится `parseBraveResults`. */
async function runBrave(
  cleanQuery: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(cleanQuery)}`;
  const response = await httpRequest(url, {
    timeoutMs,
    signal,
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  if (response.status === 429) {
    throw new Error("Brave запросил проверку.");
  }
  if (response.status >= 400) {
    throw new Error(`Brave ответил HTTP ${response.status}.`);
  }
  const results = parseBraveResults(response.body, Math.max(maxResults, 20));
  if (!results.length) {
    throw new Error("Brave не вернул результатов.");
  }
  return results;
}

type SearchEngineId = "duckduckgo" | "mwmbl" | "bing" | "brave";

const ENGINE_LABEL: Record<SearchEngineId, string> = {
  duckduckgo: "DuckDuckGo",
  mwmbl: "Mwmbl",
  bing: "Bing",
  brave: "Brave",
};

/** Явный движок идёт первым, остальные остаются запасом. */
function engineOrder(provider: WebSearchProviderId): SearchEngineId[] {
  const rest: SearchEngineId[] = ["duckduckgo", "mwmbl", "bing", "brave"];
  if (provider === "auto") {
    return rest;
  }
  return [provider, ...rest.filter((engine) => engine !== provider)];
}

/**
 * Веб-поиск с выбором движка. Запросы идут по одному и кэшируются на 10 минут.
 * Первый движок, который вернул результаты, выигрывает — остальные не дёргаем.
 */
export async function searchWeb(
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  const cleanQuery = String(query ?? "").trim();
  if (!cleanQuery) {
    return [];
  }

  const maxResults = Math.max(1, Math.min(20, Math.floor(options.maxResults ?? DEFAULT_WEB_SEARCH_RESULTS)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  const provider = normalizeSearchProvider(options.provider);

  const cacheKey = `${provider}:${cleanQuery.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return cached.results.slice(0, maxResults);
  }

  return enqueueSearch(async () => {
    const again = searchCache.get(cacheKey);
    if (again && Date.now() - again.at < SEARCH_CACHE_TTL_MS) {
      return again.results.slice(0, maxResults);
    }
    await sleep(SEARCH_GAP_MS, options.signal);

    const failures: string[] = [];
    for (const engine of engineOrder(provider)) {
      if (options.signal?.aborted) {
        throw new DOMException("Operation was aborted.", "AbortError");
      }
      try {
        const results = await runEngine(engine, cleanQuery, maxResults, timeoutMs, options.signal);
        if (results.length) {
          searchCache.set(cacheKey, { at: Date.now(), results });
          return results.slice(0, maxResults);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${ENGINE_LABEL[engine]}: ${message}`);
      }
    }

    throw new Error(
      `Поиск не удался. ${failures.join("; ")}. Повторите позже или выберите другой движок в меню «Поиск».`,
    );
  });
}

function runEngine(
  engine: SearchEngineId,
  query: string,
  maxResults: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  switch (engine) {
    case "duckduckgo":
      return runDuckDuckGo(query, maxResults, timeoutMs, signal);
    case "mwmbl":
      return runMwmbl(query, maxResults, timeoutMs, signal);
    case "bing":
      return runBing(query, maxResults, timeoutMs, signal);
    case "brave":
      return runBrave(query, maxResults, timeoutMs, signal);
  }
}

/** Обратная совместимость: поиск в режиме «Авто». */
export async function duckduckgoSearch(
  query: string,
  options: DuckDuckGoSearchOptions = {},
): Promise<WebSearchResult[]> {
  return searchWeb(query, { ...options, provider: "auto" });
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
