import { NgModule } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { NgbModule } from "@ng-bootstrap/ng-bootstrap";
import TabbyCoreModule, {
  CommandProvider,
  ConfigProvider,
  HotkeyProvider,
} from "tabby-core";
import TabbyTerminalModule, { TerminalDecorator } from "tabby-terminal";
import { SettingsTabProvider } from "tabby-settings";

// Config and Hotkeys
import { AIAgentConfigProvider } from "./config";
import { AIAgentHotkeyProvider } from "./hotkeys";

// Settings
import { AISettingsTabProvider } from "./settings";

// Services
import { AIAgentPanelService } from "./services/agent_panel.service";
import { TerminalContextService } from "./services/terminal_context.service";
import { AIAgentMemoryService } from "./services/ai_agent_memory.service";

// Decorators
import { AIAgentDecorator } from "./decorators/ai_agent.decorator";
import { AIAgentToolbarButtonProvider } from "./toolbar";

// Components
import { AIPanelComponent } from "./components/agent_panel";
import { AIAgentSettingsComponent } from "./components/agent_settings";

// Pipes
import { AIMarkdownPipe } from "./pipes/ai_markdown.pipe";

/** @hidden */
@NgModule({
  imports: [
    CommonModule,
    FormsModule,
    NgbModule,
    TabbyCoreModule,
    TabbyTerminalModule,
  ],
  providers: [
    { provide: ConfigProvider, useClass: AIAgentConfigProvider, multi: true },
    { provide: HotkeyProvider, useClass: AIAgentHotkeyProvider, multi: true },
    { provide: TerminalDecorator, useClass: AIAgentDecorator, multi: true },
    {
      provide: CommandProvider,
      useClass: AIAgentToolbarButtonProvider,
      multi: true,
    },
    {
      provide: SettingsTabProvider,
      useClass: AISettingsTabProvider,
      multi: true,
    },

    AIAgentPanelService,
    TerminalContextService,
    AIAgentMemoryService,
  ],
  declarations: [AIPanelComponent, AIAgentSettingsComponent, AIMarkdownPipe],
  exports: [AIPanelComponent],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class AIAgentModule {}

// Public API exports
export {
  TerminalContextService,
  TerminalContext,
} from "./services/terminal_context.service";

export { AIPanelComponent } from "./components/agent_panel";
export { AIAgentConfig, AIProvider } from "./config";
