import { Tool, ToolArgDefinition, ToolExecutionContext, toolProgress } from "./tool_types";
import {
  DEFAULT_WEB_SEARCH_RESULTS,
  WebToolsConfig,
  formatSearchResults,
  searchWeb,
} from "./web_client";

interface WebSearchArgs {
  query?: string;
  max_results?: number;
}

function clampResults(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(1, Math.min(15, Math.floor(base)));
}

export class WebSearchTool implements Tool {
  constructor(private config: WebToolsConfig) {}

  name(): string {
    return "web_search";
  }

  description(): string {
    return [
      "Найти информацию в интернете и вернуть заголовки, ссылки и краткие описания. Движки перебираются сами, если один недоступен.",
      "Используй для быстрых фактов, версий, новостей, документации и любых внешних сведений, которых нет в терминале или памяти.",
      "Для вопросов, требующих сбора и анализа нескольких источников, используй deep_search; для чтения конкретной страницы — web_fetch.",
    ].join(" ");
  }

  arguments(): ToolArgDefinition[] {
    return [
      {
        name: "query",
        type: "string",
        description: "Поисковый запрос (русский или английский).",
        required: true,
      },
      {
        name: "max_results",
        type: "number",
        description: "Сколько результатов вернуть (1–15). По умолчанию из настроек плагина.",
        required: false,
      },
    ];
  }

  async exec(args: WebSearchArgs, context?: ToolExecutionContext): Promise<string> {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new Error("web_search требует непустой параметр query.");
    }

    const limit = clampResults(
      args?.max_results,
      this.config.maxResults() || DEFAULT_WEB_SEARCH_RESULTS,
    );
    context?.onStateChange?.({
      status: "executing",
      output: toolProgress(`Веб-поиск: «${query}»…`),
    });

    const results = await searchWeb(query, {
      maxResults: limit,
      timeoutMs: this.config.timeoutMs(),
      provider: this.config.provider(),
      signal: context?.signal,
    });

    if (!results.length) {
      return `По запросу «${query}» ничего не найдено. Переформулируй запрос или используй другие ключевые слова.`;
    }
    return formatSearchResults(query, results);
  }

  async execSimulated(args: WebSearchArgs): Promise<string> {
    return `Имитация веб-поиска по запросу «${typeof args?.query === "string" ? args.query.trim() : ""}».`;
  }
}
