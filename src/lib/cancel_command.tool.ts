import { BaseTerminalTabComponent } from "tabby-terminal";
import { Tool, ToolArgDefinition } from "./tool_types";

export class CancelCommandTool implements Tool {
  constructor(private terminal: BaseTerminalTabComponent<any>) {}

  name(): string {
    return "cancel_command";
  }

  description(): string {
    return "Отправляет Ctrl-C в активный терминал для отмены текущей выполняемой команды.";
  }

  arguments(): ToolArgDefinition[] {
    return [];
  }

  async exec(): Promise<string> {
    if (!this.terminal.frontend) {
      throw new Error("Фронтенд терминала не готов.");
    }

    this.terminal.sendInput("\x03");
    return "Ctrl-C отправлен в активный терминал.";
  }

  async execSimulated(): Promise<string> {
    return "Имитация отправки Ctrl-C в активный терминал.";
  }
}
