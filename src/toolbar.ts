import { Injectable } from "@angular/core";
import {
  Command,
  CommandContext,
  CommandLocation,
  CommandProvider,
} from "tabby-core";
import { BaseTerminalTabComponent } from "tabby-terminal";
import { AIAgentPanelService } from "./services/agent_panel.service";

@Injectable()
export class AIAgentToolbarButtonProvider extends CommandProvider {
  constructor(private panelService: AIAgentPanelService) {
    super();
  }

  async provide(context: CommandContext): Promise<Command[]> {
    const tab = context.tab;
    if (!(tab instanceof BaseTerminalTabComponent)) {
      return [];
    }

    return [
      {
        id: "ai-agent.open",
        label: "AI Агент",
        icon: `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v3"/>
            <path d="M8 6 6 4"/>
            <path d="M16 6l2-2"/>
            <rect x="5" y="8" width="14" height="10" rx="3"/>
            <path d="M9 13h.01"/>
            <path d="M15 13h.01"/>
            <path d="M9 16h6"/>
          </svg>
        `,
        locations: [CommandLocation.RightToolbar],
        weight: 100,
        run: async () => {
          this.panelService.toggle(tab);
        },
      },
    ];
  }
}
