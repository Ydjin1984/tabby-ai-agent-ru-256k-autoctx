import { ConfigProvider, Platform } from "tabby-core";
import { CUSTOM_PRESET_ID, ReasoningEffort } from "./lib/model_presets";
import { AutoApproveMaxRisk } from "./lib/command_risk";

export type AIProvider = "openrouter" | "litellm";
export type PanelPosition = "left" | "right" | "top" | "bottom";

export interface AIAgentConfig {
  llmEndpoint: string;
  apiToken: string;
  model: string;
  /**
   * Selected model preset id (`kibborg`, `deepseek-flash`,
   * `deepseek-v4-pro`, or `custom` when the endpoint/model are typed by hand).
   */
  modelPreset: string;
  /** Reasoning level applied to every request; `off` disables thinking. */
  reasoningEffort: ReasoningEffort;
  autoApproveLowRiskCommands: boolean;
  /** Auto-approve every command regardless of risk level (dangerous). */
  autoApproveAllCommands: boolean;
  /**
   * Maximum risk level the agent may run without asking. `none` asks for
   * everything; dangerous command classes are never auto-approved.
   */
  autoApproveMaxRisk: AutoApproveMaxRisk;
  additionalRequestParametersText: string;
  additionalRequestParameters: Record<string, any>;
  additionalSystemPrompt: string;
  panelPosition: PanelPosition;
  panelSizePercent: number;
  hideTerminalOutput: boolean;
  contextWindowTokens: number;
  /** Enable the persistent memory layer (experience, procedures, lessons). */
  memoryEnabled: boolean;
  /** Maximum number of memories injected into each request. */
  memoryRetrievalLimit: number;
  /** Token budget for the injected memory block. */
  memoryContextTokens: number;
  /** Embedding backend: `auto` (Kibborg 8082 + offline fallback), `openai`, `hashed`. */
  memoryEmbeddingProvider: string;
  /** Base URL for the embeddings endpoint (never falls back to llmEndpoint). */
  memoryEmbeddingEndpoint: string;
  /** Embedding model id, e.g. `Kibborg_Embed_v1`. */
  memoryEmbeddingModel: string;
  /** Expected dimensions (0 = auto-detect). */
  memoryEmbeddingDimensions: number;
}

export class AIAgentConfigProvider extends ConfigProvider {
  defaults = {
    aiAgent: {
      llmEndpoint: "",
      apiToken: "",
      model: "default",
      modelPreset: CUSTOM_PRESET_ID,
      reasoningEffort: "off" as ReasoningEffort,
      autoApproveLowRiskCommands: false,
      autoApproveAllCommands: false,
      autoApproveMaxRisk: "none" as AutoApproveMaxRisk,
      additionalRequestParametersText: "",
      additionalRequestParameters: {},
      additionalSystemPrompt: "",
      panelPosition: "right" as PanelPosition,
      panelSizePercent: 40,
      hideTerminalOutput: false,
      contextWindowTokens: 256000,
      memoryEnabled: true,
      memoryRetrievalLimit: 6,
      memoryContextTokens: 1200,
      // Semantic retrieval runs on the Kibborg embedding server (`Kibborg_Embed_v1`,
      // 1024 dims, port 8082); if it is unreachable the provider degrades to
      // offline hashed vectors instead of failing.
      memoryEmbeddingProvider: "auto",
      memoryEmbeddingEndpoint: "http://127.0.0.1:8082",
      memoryEmbeddingModel: "Kibborg_Embed_v1",
      memoryEmbeddingDimensions: 0,
    },
    hotkeys: {
      "toggle-ai-agent-panel": ["Ctrl-Alt-A"],
      "stop-ai-agent-response": ["Ctrl-Alt-S"],
      "approve-ai-agent-command": ["Ctrl-Alt-Enter"],
      "decline-ai-agent-command": ["Ctrl-Alt-Backspace"],
      "clear-ai-agent-chat": ["Ctrl-Alt-C"],
      "force-read-terminal": ["Ctrl-Alt-P"],
    },
  };

  platformDefaults = {
    [Platform.macOS]: {
      hotkeys: {
        "toggle-ai-agent-panel": ["Cmd-Shift-A"],
        "stop-ai-agent-response": ["Ctrl-Alt-S"],
        "approve-ai-agent-command": ["Cmd-Shift-Enter"],
        "decline-ai-agent-command": ["Cmd-Shift-Backspace"],
        "clear-ai-agent-chat": ["Cmd-Shift-C"],
        "force-read-terminal": ["Cmd-Shift-P"],
      },
    },
  };
}
