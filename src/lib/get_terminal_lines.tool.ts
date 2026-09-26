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
    /**
     * Optional check: true while a shell command the agent launched is still
     * running. Polling the terminal in that window is pointless — the command
     * tool already returns the output when it finishes — and a reasoning model
     * otherwise spams this call in a loop. Returning a short "still running"
     * answer both saves context and stops the loop.
     */
    private isBusy?: () => boolean,
  ) {}

  name(): string {
    return "get_terminal_lines";
  }

  description(): string {
    return [
      "Возвращает последние N строк буфера текущего терминала.",
      "Не вызывай его повторно в цикле: run_shell_command уже возвращает вывод после завершения команды.",
    ].join(" ");
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
    if (this.isBusy?.()) {
      return "Команда ещё выполняется. Не опрашивай терминал повторно — дождись результата run_shell_command; он вернёт вывод по завершении.";
    }

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
