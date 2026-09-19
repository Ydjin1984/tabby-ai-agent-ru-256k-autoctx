import { Frontend } from "tabby-terminal";
import { TerminalContextService } from "../services/terminal_context.service";
import { Tool, ToolArgDefinition } from "./tool_types";

interface GetTerminalLinesArgs {
  lines: number;
}

export class GetTerminalLinesTool implements Tool {
  constructor(
    private frontend: Frontend,
    private terminalContext: TerminalContextService,
  ) {}

  name(): string {
    return "get_terminal_lines";
  }

  description(): string {
    return "Возвращает последние N строк буфера текущего терминала.";
  }

  arguments(): ToolArgDefinition[] {
    return [
      {
        name: "lines",
        type: "number",
        description: "Количество последних строк терминала для возврата.",
        required: true,
      },
    ];
  }

  async exec(args: GetTerminalLinesArgs): Promise<string> {
    const requestedLines = Number.isFinite(args.lines) ? Math.floor(args.lines) : 0;
    const lines = Math.max(1, Math.min(500, requestedLines || 50));
    const context = this.terminalContext.getLastNLines(this.frontend, lines);

    if (!context) {
      throw new Error("Фронтенд терминала не готов.");
    }

    return context.content || "Нет доступного содержимого терминала.";
  }

  async execSimulated(args: GetTerminalLinesArgs): Promise<string> {
    const lines = Math.max(1, Math.min(500, Math.floor(args.lines || 50)));
    return `Имитация снимка терминала за последние ${lines} строк.`;
  }
}
