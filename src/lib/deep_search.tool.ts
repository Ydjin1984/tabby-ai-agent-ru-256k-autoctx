import {
  Tool,
  ToolArgDefinition,
  ToolExecutionContext,
  toolProgress,
} from "./tool_types";
import {
  DEFAULT_DEEP_SEARCH_PAGES,
  FetchedPage,
  WebSearchResult,
  WebToolsConfig,
  duckduckgoSearch,
  fetchPageText,
} from "./web_client";

interface DeepSearchArgs {
  query?: string;
  sub_queries?: string[];
  max_pages?: number;
}

function clampPages(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(10, Math.floor(base)));
}

function normalizeSubQueries(value: unknown, query: string): string[] {
  const list: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = typeof item === "string" ? item.trim() : "";
      if (text && !list.includes(text)) {
        list.push(text);
      }
    }
  }
  if (!list.length) {
    list.push(query);
  }
  return list.slice(0, 6);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export class DeepSearchTool implements Tool {
  constructor(private config: WebToolsConfig) {}

  name(): string {
    return "deep_search";
  }

  description(): string {
    return [
      "Глубокий ресёрч: разбей вопрос на 2–5 подзапросов, найди источники по каждому, прочитай несколько страниц и верни структурированное досье с фактами и ссылками.",
      "Используй для сравнений, обзоров, спорных и быстро меняющихся тем, где одного сниппета мало.",
      "Заполняй sub_queries своими формулировками (синонимы, уточнения, разные языки) — так покрытие будет шире. После досье синтезируй итоговый ответ сам.",
    ].join(" ");
  }

  arguments(): ToolArgDefinition[] {
    return [
      {
        name: "query",
        type: "string",
        description: "Исходный исследовательский вопрос.",
        required: true,
      },
      {
        name: "sub_queries",
        type: "array",
        description: "2–5 уточняющих подзапросов для параллельного поиска.",
        required: false,
      },
      {
        name: "max_pages",
        type: "number",
        description: "Сколько источников прочитать целиком (1–10).",
        required: false,
      },
    ];
  }

  async exec(args: DeepSearchArgs, context?: ToolExecutionContext): Promise<string> {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new Error("deep_search требует непустой параметр query.");
    }

    const subQueries = normalizeSubQueries(args?.sub_queries, query);
    const maxPages = clampPages(
      args?.max_pages,
      this.config.maxPages() || DEFAULT_DEEP_SEARCH_PAGES,
    );
    const timeoutMs = this.config.timeoutMs();
    const charLimit = this.config.charLimit();

    context?.onStateChange?.({
      status: "executing",
      output: toolProgress(
        `Глубокий поиск: ${subQueries.length} подзапрос(ов) — собираю источники…`,
      ),
    });

    const searches = await Promise.all(
      subQueries.map((subQuery) =>
        duckduckgoSearch(subQuery, {
          maxResults: this.config.maxResults(),
          timeoutMs,
          signal: context?.signal,
        }).catch(() => [] as WebSearchResult[]),
      ),
    );

    const order: string[] = [];
    const byUrl = new Map<string, { result: WebSearchResult; hits: number }>();
    searches.forEach((results) => {
      results.forEach((result) => {
        if (!result.url) {
          return;
        }
        const existing = byUrl.get(result.url);
        if (existing) {
          existing.hits += 1;
          if (!existing.result.snippet && result.snippet) {
            existing.result = result;
          }
          return;
        }
        byUrl.set(result.url, { result, hits: 1 });
        order.push(result.url);
      });
    });

    const targets = order
      .map((url, index) => ({ entry: byUrl.get(url)!, index }))
      .sort((a, b) => b.entry.hits - a.entry.hits || a.index - b.index)
      .slice(0, maxPages)
      .map((item) => item.entry.result);

    if (!targets.length) {
      return `Глубокий поиск по запросу «${query}» не нашёл источников. Уточни формулировку или используй web_search.`;
    }

    const pages: Array<FetchedPage | null> = new Array(targets.length).fill(null);
    let cursor = 0;
    let fetched = 0;
    const workerCount = Math.min(3, targets.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= targets.length) {
          return;
        }
        const target = targets[index];
        context?.onStateChange?.({
          status: "executing",
          output: toolProgress(
            `Глубокий поиск: читаю источник ${index + 1}/${targets.length} — ${hostOf(target.url)}…`,
          ),
        });
        try {
          pages[index] = await fetchPageText(target.url, {
            timeoutMs,
            charLimit,
            signal: context?.signal,
          });
        } catch {
          pages[index] = null;
        } finally {
          fetched += 1;
        }
      }
    });
    await Promise.all(workers);

    const lines: string[] = [
      `# Досье глубокого поиска: «${query}»`,
      "",
      `Подзапросы: ${subQueries.join("; ")}`,
      `Источников выбрано: ${targets.length}, прочитано: ${fetched}`,
      "",
    ];

    targets.forEach((target, index) => {
      const page = pages[index];
      lines.push(`## ${index + 1}. ${page?.title || target.title}`);
      lines.push(`URL: ${page?.url || target.url}`);
      if (target.snippet) {
        lines.push(`Сниппет: ${target.snippet}`);
      }
      lines.push("");
      if (page?.text) {
        lines.push(page.text);
        if (page.truncated) {
          lines.push("[текст обрезан по лимиту]");
        }
      } else {
        lines.push("Не удалось прочитать страницу — используй сниппет и другие источники.");
      }
      lines.push("");
      lines.push("---");
      lines.push("");
    });

    lines.push("## Список источников");
    targets.forEach((target, index) => {
      lines.push(`${index + 1}. ${target.title} — ${target.url}`);
    });
    lines.push("");
    lines.push(
      "Синтезируй итоговый ответ из этого досье: структурированный Markdown, таблица ключевых фактов, обязательные ссылки на источники.",
    );

    return lines.join("\n").trim();
  }

  async execSimulated(args: DeepSearchArgs): Promise<string> {
    return `Имитация глубокого поиска: «${typeof args?.query === "string" ? args.query : ""}».`;
  }
}
