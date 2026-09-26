import { ConfigProvider, Platform } from "tabby-core";
import { ReasoningEffort } from "./lib/model_presets";
import { AutoApproveMaxRisk } from "./lib/command_risk";
import { DEFAULT_PANEL_THEME_ID } from "./lib/panel_themes";
import {
  AIProviderConfig,
  DEFAULT_PROVIDER_ID,
  DEFAULT_PROVIDERS,
  cloneProviders,
} from "./lib/providers";

export type AIProvider = "openrouter" | "litellm";
export type PanelPosition = "left" | "right" | "top" | "bottom";

export interface AIAgentConfig {
  llmEndpoint: string;
  apiToken: string;
  model: string;
  /** All configured providers, each with its own API key. */
  providers: AIProviderConfig[];
  /** Id of the provider currently applied to the panel. */
  activeProviderId: string;
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
  /** Enable the `web_search` tool (quick DuckDuckGo lookups). */
  webSearchEnabled: boolean;
  /** Enable the `deep_search` tool (multi-source research dossier). */
  deepSearchEnabled: boolean;
  /** Max results per web search query. */
  webSearchMaxResults: number;
  /** Max sources a deep search reads in full. */
  deepSearchMaxPages: number;
  /** Per-request timeout for web calls, milliseconds. */
  webSearchTimeoutMs: number;
  /** Max characters extracted from one page. */
  webFetchCharLimit: number;
  /** Search engine for web tools: `auto`, `duckduckgo` or `brave`. */
  webSearchProvider: string;
  /** Visual theme of the panel (see lib/panel_themes). Default: neon-log. */
  panelTheme: string;
}

const DEFAULT_ACTIVE_PROVIDER = DEFAULT_PROVIDERS[0];

export class AIAgentConfigProvider extends ConfigProvider {
  defaults = {
    aiAgent: {
      llmEndpoint: DEFAULT_ACTIVE_PROVIDER?.endpoint ?? "",
      apiToken: DEFAULT_ACTIVE_PROVIDER?.apiToken ?? "",
      model: DEFAULT_ACTIVE_PROVIDER?.model ?? "default",
      providers: cloneProviders(),
      activeProviderId: DEFAULT_ACTIVE_PROVIDER?.id ?? DEFAULT_PROVIDER_ID,
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
      // Интернет-инструменты по умолчанию выключены: их включают тумблерами в
      // шапке панели (Web / Deep), чтобы модель не ходила в сеть без запроса.
      webSearchEnabled: false,
      deepSearchEnabled: false,
      webSearchMaxResults: 6,
      deepSearchMaxPages: 6,
      webSearchTimeoutMs: 15000,
      webFetchCharLimit: 4000,
      webSearchProvider: "auto",
      panelTheme: DEFAULT_PANEL_THEME_ID,
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
