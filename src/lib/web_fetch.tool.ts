import { Tool, ToolArgDefinition, ToolExecutionContext, toolProgress } from "./tool_types";
import { WebToolsConfig, fetchPageText } from "./web_client";

interface WebFetchArgs {
  url?: string;
  max_chars?: number;
}

function clampChars(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(500, Math.min(20000, Math.floor(base)));
}

export class WebFetchTool implements Tool {
  constructor(private config: WebToolsConfig) {}

  name(): string {
    return "web_fetch";
  }

  description(): string {
    return [
      "Прочитать конкретную веб-страницу по URL и вернуть её заголовок и основной текст.",
      "Используй, когда нужен первоисточник: документация, статья, changelog, страница релиза, ответ на форуме.",
      "URL бери только из результатов web_search/deep_search или от пользователя — не выдумывай адреса.",
    ].join(" ");
  }

  arguments(): ToolArgDefinition[] {
    return [
      {
        name: "url",
        type: "string",
        description: "Полный URL страницы (http/https).",
        required: true,
      },
      {
        name: "max_chars",
        type: "number",
        description: "Сколько символов текста вернуть (500–20000).",
        required: false,
      },
    ];
  }

  async exec(args: WebFetchArgs, context?: ToolExecutionContext): Promise<string> {
    const url = typeof args?.url === "string" ? args.url.trim() : "";
    if (!url) {
      throw new Error("web_fetch требует непустой параметр url.");
    }

    context?.onStateChange?.({
      status: "executing",
      output: toolProgress(`Чтение страницы: ${url}…`),
    });

    const page = await fetchPageText(url, {
      timeoutMs: this.config.timeoutMs(),
      charLimit: clampChars(args?.max_chars, this.config.charLimit()),
      signal: context?.signal,
    });

    const lines = [`# ${page.title}`, "", `URL: ${page.url}`, ""];
    if (!page.text) {
      lines.push("На странице не найден читаемый текст (возможно, контент подгружается скриптами).");
    } else {
      lines.push(page.text);
      if (page.truncated) {
        lines.push("");
        lines.push("[текст обрезан по лимиту]");
      }
    }
    return lines.join("\n");
  }

  async execSimulated(args: WebFetchArgs): Promise<string> {
    return `Имитация чтения страницы: ${typeof args?.url === "string" ? args.url : ""}.`;
  }
}
