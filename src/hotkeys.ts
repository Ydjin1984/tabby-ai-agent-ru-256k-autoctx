import { Injectable } from "@angular/core";
import {
  HotkeyDescription,
  HotkeyProvider,
  TranslateService,
} from "tabby-core";

@Injectable()
export class AIAgentHotkeyProvider extends HotkeyProvider {
  constructor(private translate: TranslateService) {
    super();
  }

  async provide(): Promise<HotkeyDescription[]> {
    return [
      {
        id: "toggle-ai-agent-panel",
        name: this.translate.instant("Переключить панель AI Agent"),
      },
      {
        id: "stop-ai-agent-response",
        name: this.translate.instant("Остановить ответ AI Agent"),
      },
      {
        id: "approve-ai-agent-command",
        name: this.translate.instant("Одобрить команду AI Agent"),
      },
      {
        id: "decline-ai-agent-command",
        name: this.translate.instant("Отклонить команду AI Agent"),
      },
      {
        id: "clear-ai-agent-chat",
        name: this.translate.instant("Очистить чат AI Agent"),
      },
      {
        id: "force-read-terminal",
        name: this.translate.instant("Принудительно прочитать терминал"),
      },
    ];
  }
}
