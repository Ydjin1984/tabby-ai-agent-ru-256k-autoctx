import { Component, HostBinding, OnInit } from "@angular/core";
import { ConfigService } from "tabby-core";
import { PanelPosition } from "../config";
import {
  AutoApproveMaxRisk,
  isAutoApproveMaxRisk,
} from "../lib/command_risk";
import { checkpointLLMEndpoint } from "../lib/llm_chat_session";
import { AIAgentMemoryService } from "../services/ai_agent_memory.service";
import { MemoryEntry, TaskMetrics, describeEnvironment } from "../memory";

interface MemoryItemView {
  id: string;
  type: string;
  typeLabel: string;
  status: string;
  text: string;
  solution: string;
  action: string;
  environment: string;
  confidence: number;
  successCount: number;
  failureCount: number;
  useCount: number;
  pinned: boolean;
  disabled: boolean;
  conflict: boolean;
  supersededBy: string | null;
  sessionId: string;
  command: string;
  createdAt: number;
  expanded: boolean;
}
import { normalizeOpenAIBaseUrl } from "../lib/llm_endpoint";
import {
  DEFAULT_PANEL_THEME_ID,
  PANEL_THEMES,
  PanelTheme,
  isPanelThemeId,
} from "../lib/panel_themes";
import {
  REASONING_EFFORTS,
  ReasoningEffort,
  describeReasoning,
  isReasoningEffort,
  resolveReasoningStyle,
} from "../lib/model_presets";
import {
  AIProviderConfig,
  DEFAULT_PROVIDER_ID,
  cloneProviders,
  createProviderId,
  findProvider,
} from "../lib/providers";

@Component({
  templateUrl: "./agent_settings.html",
  styleUrls: ["./agent_settings.scss"],
})
export class AIAgentSettingsComponent implements OnInit {
  additionalSystemPrompt = "";
  @HostBinding("class.content-box") true;
  providers: AIProviderConfig[] = [];
  activeProviderId = DEFAULT_PROVIDER_ID;
  reasoningEffort: ReasoningEffort = "off";
  readonly reasoningEfforts = REASONING_EFFORTS;
  additionalRequestParametersText = "";
  additionalRequestParametersError: string | null = null;
  autoApproveMaxRisk: AutoApproveMaxRisk = "none";
  readonly autoApproveOptions: Array<{ id: AutoApproveMaxRisk; label: string; hint: string }> = [
    { id: "none", label: "Спрашивать всегда", hint: "ни одна команда не выполняется без подтверждения" },
    { id: "low", label: "Авто: до low", hint: "безопасные команды чтения выполняются сразу" },
    { id: "medium", label: "Авто: до medium", hint: "обычные изменения выполняются сразу" },
    { id: "high", label: "Авто: до high", hint: "почти всё автоматически, кроме critical" },
    { id: "critical", label: "Авто: все уровни", hint: "максимальная скорость — подтверждение только для явно опасных команд" },
  ];

  // Memory Inspector
  memorySearch = "";
  memoryFilterType = "all";
  memoryFilterStatus = "all";
  memoryItems: MemoryItemView[] = [];
  memoryTotal = 0;
  memoryStatusCounts: Record<string, number> = {};
  memoryTypeCounts: Record<string, number> = {};
  memoryMetrics: TaskMetrics | null = null;
  memoryInspectorMessage = "";
  readonly memoryTypeOptions = [
    { id: "all", label: "Все" },
    { id: "episode", label: "Эпизоды" },
    { id: "procedure", label: "Процедуры" },
    { id: "lesson", label: "Уроки" },
    { id: "avoid", label: "Избегать" },
    { id: "fact", label: "Факты" },
    { id: "task", label: "Задачи" },
  ];
  readonly memoryStatusOptions = [
    { id: "all", label: "Любой статус" },
    { id: "candidate", label: "Candidate" },
    { id: "validated", label: "Validated" },
    { id: "trusted", label: "Trusted" },
    { id: "superseded", label: "Superseded" },
  ];
  panelPosition: PanelPosition = "right";
  panelSizePercent = 40;
  readonly panelThemes: PanelTheme[] = PANEL_THEMES;
  panelTheme = DEFAULT_PANEL_THEME_ID;
  webSearchEnabled = false;
  deepSearchEnabled = false;
  webSearchMaxResults = 6;
  deepSearchMaxPages = 6;
  webSearchTimeoutMs = 8000;
  webFetchCharLimit = 4000;
  memoryEnabled = true;
  memoryRetrievalLimit = 6;
  endpointCheckpointStatus:
    | "idle"
    | "checking"
    | "valid"
    | "invalid"
    | "empty" = "idle";
  endpointCheckpointMessage = "";
  private endpointCheckpointSequence = 0;

  constructor(
    public config: ConfigService,
    private memoryService: AIAgentMemoryService,
  ) {}

  ngOnInit(): void {
    this.ensureConfigDefaults();
    this.providers = this.config.store.aiAgent.providers ?? [];
    this.activeProviderId =
      this.config.store.aiAgent.activeProviderId ??
      this.providers[0]?.id ??
      DEFAULT_PROVIDER_ID;
    this.reasoningEffort = isReasoningEffort(
      this.config.store.aiAgent.reasoningEffort,
    )
      ? this.config.store.aiAgent.reasoningEffort
      : "off";
    this.additionalSystemPrompt = this.config.store.aiAgent.additionalSystemPrompt;
    this.additionalRequestParametersText =
      this.config.store.aiAgent.additionalRequestParametersText;
    this.panelPosition = this.config.store.aiAgent.panelPosition ?? "right";
    this.panelSizePercent = this.config.store.aiAgent.panelSizePercent ?? 40;
    this.panelTheme = isPanelThemeId(this.config.store.aiAgent.panelTheme)
      ? this.config.store.aiAgent.panelTheme
      : DEFAULT_PANEL_THEME_ID;
    this.webSearchEnabled = this.config.store.aiAgent.webSearchEnabled === true;
    this.deepSearchEnabled = this.config.store.aiAgent.deepSearchEnabled === true;
    this.webSearchMaxResults = this.config.store.aiAgent.webSearchMaxResults ?? 6;
    this.deepSearchMaxPages = this.config.store.aiAgent.deepSearchMaxPages ?? 6;
    this.webSearchTimeoutMs = this.config.store.aiAgent.webSearchTimeoutMs ?? 8000;
    this.webFetchCharLimit = this.config.store.aiAgent.webFetchCharLimit ?? 4000;
    this.memoryEnabled = this.config.store.aiAgent.memoryEnabled !== false;
    this.memoryRetrievalLimit = this.config.store.aiAgent.memoryRetrievalLimit ?? 6;
    this.autoApproveMaxRisk = isAutoApproveMaxRisk(
      this.config.store.aiAgent.autoApproveMaxRisk,
    )
      ? this.config.store.aiAgent.autoApproveMaxRisk
      : "none";
    void this.refreshMemoryInspector();
  }

  // ---------------------------------------------------------------
  // Провайдеры (у каждого — свой ключ)
  // ---------------------------------------------------------------

  get activeProvider(): AIProviderConfig | null {
    return findProvider(this.providers, this.activeProviderId) ?? null;
  }

  trackProvider(_index: number, provider: AIProviderConfig): string {
    return provider.id;
  }

  /** Активирует провайдера и применяет его endpoint/model/ключ к панели. */
  async selectProvider(id: string): Promise<void> {
    const provider = findProvider(this.providers, id);
    if (!provider) {
      return;
    }
    this.activeProviderId = provider.id;
    const aiAgent = this.config.store.aiAgent;
    aiAgent.activeProviderId = provider.id;
    aiAgent.llmEndpoint = provider.endpoint;
    aiAgent.model = provider.model || "default";
    aiAgent.apiToken = provider.apiToken;
    if (provider.contextWindowTokens) {
      aiAgent.contextWindowTokens = provider.contextWindowTokens;
    }
    await this.config.save();
    this.checkLLMEndpoint();
  }

  async addProvider(): Promise<void> {
    const id = createProviderId(this.providers);
    const provider: AIProviderConfig = {
      id,
      label: "Новая модель",
      endpoint: "",
      model: "",
      apiToken: "",
    };
    this.providers = [...this.providers, provider];
    this.config.store.aiAgent.providers = this.providers;
    await this.selectProvider(id);
  }

  async removeProvider(id: string): Promise<void> {
    if (this.providers.length <= 1) {
      return;
    }
    this.providers = this.providers.filter((provider) => provider.id !== id);
    this.config.store.aiAgent.providers = this.providers;
    if (this.activeProviderId === id) {
      await this.selectProvider(this.providers[0].id);
    } else {
      await this.config.save();
    }
  }

  /** Правка поля активного провайдера; активный сразу применяется к панели. */
  async updateProviderField(
    field: "label" | "endpoint" | "model" | "apiToken",
    value: string,
  ): Promise<void> {
    const provider = this.activeProvider;
    if (!provider) {
      return;
    }
    if (field === "endpoint") {
      provider.endpoint = this.normalizeEndpoint(value);
    } else if (field === "model") {
      provider.model = value.trim();
    } else if (field === "label") {
      provider.label = value;
    } else {
      provider.apiToken = value;
    }
    this.providers = [...this.providers];
    const aiAgent = this.config.store.aiAgent;
    aiAgent.providers = this.providers;
    if (field === "endpoint") {
      aiAgent.llmEndpoint = provider.endpoint;
    }
    if (field === "model") {
      aiAgent.model = provider.model || "default";
    }
    if (field === "apiToken") {
      aiAgent.apiToken = provider.apiToken;
    }
    await this.config.save();
  }

  async saveReasoningEffort(value: string): Promise<void> {
    if (!isReasoningEffort(value)) {
      return;
    }
    this.reasoningEffort = value;
    this.config.store.aiAgent.reasoningEffort = value;
    await this.config.save();
  }

  /** What the reasoning selector will actually send for the current model. */
  get reasoningHint(): string {
    return describeReasoning(
      this.reasoningStyle,
      this.reasoningEffort,
    );
  }

  get reasoningStyle(): ReturnType<typeof resolveReasoningStyle> {
    return resolveReasoningStyle(
      this.config.store.aiAgent.llmEndpoint ?? "",
      this.config.store.aiAgent.model ?? "",
    );
  }

  checkLLMEndpoint(): void {
    this.startEndpointCheckpoint(
      this.config.store.aiAgent.llmEndpoint,
      this.config.store.aiAgent.apiToken,
      this.config.store.aiAgent.model,
    );
  }

  async saveAutoApproveLowRiskCommands(value: boolean): Promise<void> {
    this.config.store.aiAgent.autoApproveLowRiskCommands = value;
    await this.config.save();
  }

  async saveAutoApproveMaxRisk(value: string): Promise<void> {
    if (!isAutoApproveMaxRisk(value)) {
      return;
    }
    this.autoApproveMaxRisk = value;
    this.config.store.aiAgent.autoApproveMaxRisk = value;
    // Retire the legacy boolean toggles so the policy is the single source of truth.
    this.config.store.aiAgent.autoApproveAllCommands = false;
    await this.config.save();
  }

  async saveAdditionalSystemPrompt(value: string): Promise<void> {
    this.additionalSystemPrompt = value;
    this.config.store.aiAgent.additionalSystemPrompt = value;
    await this.config.save();
  }

  async saveAdditionalRequestParametersText(value: string): Promise<void> {
    this.additionalRequestParametersText = value;

    const parsed = this.parseAdditionalRequestParameters(value);
    if (!parsed.ok) {
      this.additionalRequestParametersError = parsed.error;
      return;
    }

    this.additionalRequestParametersError = null;
    this.config.store.aiAgent.additionalRequestParametersText = value;
    this.config.store.aiAgent.additionalRequestParameters = parsed.value;
    await this.config.save();
  }

  async savePanelPosition(value: PanelPosition): Promise<void> {
    this.panelPosition = value;
    this.config.store.aiAgent.panelPosition = value;
    await this.config.save();
  }

  async savePanelSizePercent(value: number): Promise<void> {
    const clamped = Math.min(90, Math.max(10, Math.round(value)));
    this.panelSizePercent = clamped;
    this.config.store.aiAgent.panelSizePercent = clamped;
    await this.config.save();
  }

  async saveHideTerminalOutput(value: boolean): Promise<void> {
    this.config.store.aiAgent.hideTerminalOutput = value;
    await this.config.save();
  }

  async savePanelTheme(value: string): Promise<void> {
    if (!isPanelThemeId(value)) {
      return;
    }
    this.panelTheme = value;
    this.config.store.aiAgent.panelTheme = value;
    await this.config.save();
  }

  async saveWebSearchEnabled(value: boolean): Promise<void> {
    this.webSearchEnabled = value;
    this.config.store.aiAgent.webSearchEnabled = value;
    await this.config.save();
  }

  async saveDeepSearchEnabled(value: boolean): Promise<void> {
    this.deepSearchEnabled = value;
    this.config.store.aiAgent.deepSearchEnabled = value;
    await this.config.save();
  }

  async saveWebSearchMaxResults(value: number): Promise<void> {
    const clamped = Math.min(15, Math.max(1, Math.round(Number(value) || 6)));
    this.webSearchMaxResults = clamped;
    this.config.store.aiAgent.webSearchMaxResults = clamped;
    await this.config.save();
  }

  async saveDeepSearchMaxPages(value: number): Promise<void> {
    const clamped = Math.min(10, Math.max(1, Math.round(Number(value) || 6)));
    this.deepSearchMaxPages = clamped;
    this.config.store.aiAgent.deepSearchMaxPages = clamped;
    await this.config.save();
  }

  async saveWebSearchTimeoutMs(value: number): Promise<void> {
    const clamped = Math.min(60000, Math.max(1000, Math.round(Number(value) || 8000)));
    this.webSearchTimeoutMs = clamped;
    this.config.store.aiAgent.webSearchTimeoutMs = clamped;
    await this.config.save();
  }

  async saveWebFetchCharLimit(value: number): Promise<void> {
    const clamped = Math.min(20000, Math.max(500, Math.round(Number(value) || 4000)));
    this.webFetchCharLimit = clamped;
    this.config.store.aiAgent.webFetchCharLimit = clamped;
    await this.config.save();
  }

  async saveMemoryEnabled(value: boolean): Promise<void> {
    this.memoryEnabled = value;
    this.config.store.aiAgent.memoryEnabled = value;
    await this.config.save();
  }

  async saveMemoryRetrievalLimit(value: number): Promise<void> {
    const clamped = Math.min(20, Math.max(1, Math.round(value)));
    this.memoryRetrievalLimit = clamped;
    this.config.store.aiAgent.memoryRetrievalLimit = clamped;
    await this.config.save();
  }

  // ---------------------------------------------------------------
  // Memory Inspector
  // ---------------------------------------------------------------

  async refreshMemoryInspector(): Promise<void> {
    try {
      const manager = this.memoryService.manager;
      await manager.initialize();
      const stats = manager.getStats();
      this.memoryTotal = stats.total;
      this.memoryStatusCounts = stats.byStatus;
      this.memoryTypeCounts = stats.byType;
      this.memoryMetrics = manager.getMetrics();
      const entries = manager.searchMemories({
        query: this.memorySearch,
        type: this.memoryFilterType as MemoryEntry["type"] | "all",
        status: this.memoryFilterStatus as any,
      });
      const expanded = new Set(
        this.memoryItems.filter((item) => item.expanded).map((item) => item.id),
      );
      this.memoryItems = entries.map((entry) =>
        this.toMemoryItemView(entry, expanded.has(entry.id)),
      );
      this.memoryInspectorMessage = "";
    } catch (error) {
      this.memoryInspectorMessage =
        error instanceof Error ? error.message : String(error);
    }
  }

  onMemorySearchChange(value: string): void {
    this.memorySearch = value;
    void this.refreshMemoryInspector();
  }

  onMemoryFilterTypeChange(value: string): void {
    this.memoryFilterType = value;
    void this.refreshMemoryInspector();
  }

  onMemoryFilterStatusChange(value: string): void {
    this.memoryFilterStatus = value;
    void this.refreshMemoryInspector();
  }

  toggleMemoryItem(id: string): void {
    this.memoryItems = this.memoryItems.map((item) =>
      item.id === id ? { ...item, expanded: !item.expanded } : item,
    );
  }

  trackMemoryItem(_index: number, item: MemoryItemView): string {
    return item.id;
  }

  forgetMemory(id: string): void {
    this.memoryService.manager.deleteMemory(id);
    void this.refreshMemoryInspector();
  }

  toggleMemoryDisabled(item: MemoryItemView): void {
    this.memoryService.manager.setMemoryDisabled(item.id, !item.disabled);
    void this.refreshMemoryInspector();
  }

  toggleMemoryPinned(item: MemoryItemView): void {
    this.memoryService.manager.setMemoryPinned(item.id, !item.pinned);
    void this.refreshMemoryInspector();
  }

  promoteMemory(id: string): void {
    const entry = this.memoryService.manager.getMemory(id);
    if (!entry) {
      return;
    }
    this.memoryService.manager.setMemoryStatus(
      id,
      entry.status === "candidate" ? "validated" : "trusted",
    );
    void this.refreshMemoryInspector();
  }

  demoteMemory(id: string): void {
    const entry = this.memoryService.manager.getMemory(id);
    if (!entry) {
      return;
    }
    this.memoryService.manager.setMemoryStatus(
      id,
      entry.status === "trusted" ? "validated" : "candidate",
    );
    void this.refreshMemoryInspector();
  }

  async reindexMemory(): Promise<void> {
    try {
      const count = await this.memoryService.reindex();
      this.memoryInspectorMessage = `Переиндексировано записей: ${count}.`;
    } catch (error) {
      this.memoryInspectorMessage =
        error instanceof Error ? error.message : String(error);
    }
    await this.refreshMemoryInspector();
  }

  async forgetAllMemory(): Promise<void> {
    await this.memoryService.manager.clear();
    await this.refreshMemoryInspector();
  }

  get memoryFirstAttemptRate(): string {
    return this.memoryMetrics
      ? `${Math.round(this.memoryMetrics.firstAttemptSuccessRate * 100)}%`
      : "—";
  }

  get memoryHitRateDisplay(): string {
    return this.memoryMetrics
      ? `${Math.round(this.memoryMetrics.memoryHitRate * 100)}%`
      : "—";
  }

  get memoryBadRateDisplay(): string {
    return this.memoryMetrics
      ? `${Math.round(this.memoryMetrics.badMemoryRate * 100)}%`
      : "—";
  }

  get memoryAvgAttemptsDisplay(): string {
    return this.memoryMetrics
      ? this.memoryMetrics.averageAttemptsBeforeSuccess.toFixed(1)
      : "—";
  }

  private toMemoryItemView(entry: MemoryEntry, expanded: boolean): MemoryItemView {
    return {
      id: entry.id,
      type: entry.type,
      typeLabel: this.memoryTypeLabel(entry.type),
      status: entry.status,
      text: entry.text,
      solution: entry.solution || entry.action,
      action: entry.action,
      environment: describeEnvironment(entry.environment),
      confidence: entry.confidence,
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      useCount: entry.useCount,
      pinned: Boolean(entry.pinned),
      disabled: Boolean(entry.disabled),
      conflict: Boolean(entry.data?.conflict),
      supersededBy: entry.supersededBy ?? null,
      sessionId: entry.provenance?.sessionId ?? "",
      command: entry.provenance?.command ?? "",
      createdAt: entry.createdAt,
      expanded,
    };
  }

  private memoryTypeLabel(type: string): string {
    switch (type) {
      case "episode":
        return "ЭПИЗОД";
      case "procedure":
        return "ПРОЦЕДУРА";
      case "lesson":
        return "УРОК";
      case "avoid":
        return "ИЗБЕГАТЬ";
      case "fact":
        return "ФАКТ";
      case "task":
        return "ЗАДАЧА";
      default:
        return type.toUpperCase();
    }
  }

  formatMemoryDate(timestamp: number): string {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return "";
    }
  }

  private ensureConfigDefaults(): void {
    this.config.store.aiAgent ??= {};
    if (!Array.isArray(this.config.store.aiAgent.providers)) {
      this.config.store.aiAgent.providers = cloneProviders();
    }
    if (
      !findProvider(
        this.config.store.aiAgent.providers,
        this.config.store.aiAgent.activeProviderId,
      )
    ) {
      this.config.store.aiAgent.activeProviderId =
        this.config.store.aiAgent.providers[0]?.id ?? DEFAULT_PROVIDER_ID;
    }
    this.config.store.aiAgent.llmEndpoint ??= "";
    this.config.store.aiAgent.apiToken ??= "";
    this.config.store.aiAgent.model ??= "default";
    if (!isReasoningEffort(this.config.store.aiAgent.reasoningEffort)) {
      this.config.store.aiAgent.reasoningEffort = "off";
    }
    this.config.store.aiAgent.autoApproveLowRiskCommands ??= false;
    this.config.store.aiAgent.autoApproveAllCommands ??= false;
    if (!isAutoApproveMaxRisk(this.config.store.aiAgent.autoApproveMaxRisk)) {
      this.config.store.aiAgent.autoApproveMaxRisk = "none";
    }
    this.config.store.aiAgent.additionalRequestParametersText ??= "";
    this.config.store.aiAgent.additionalRequestParameters ??= {};
    this.config.store.aiAgent.additionalSystemPrompt ??= "";
    this.config.store.aiAgent.panelPosition ??= "right";
    this.config.store.aiAgent.panelSizePercent ??= 40;
    if (!isPanelThemeId(this.config.store.aiAgent.panelTheme)) {
      this.config.store.aiAgent.panelTheme = DEFAULT_PANEL_THEME_ID;
    }
    this.config.store.aiAgent.hideTerminalOutput ??= false;
    this.config.store.aiAgent.webSearchEnabled ??= false;
    this.config.store.aiAgent.deepSearchEnabled ??= false;
    this.config.store.aiAgent.webSearchMaxResults ??= 6;
    this.config.store.aiAgent.deepSearchMaxPages ??= 6;
    this.config.store.aiAgent.webSearchTimeoutMs ??= 8000;
    this.config.store.aiAgent.webFetchCharLimit ??= 4000;
    this.config.store.aiAgent.memoryEnabled ??= true;
    this.config.store.aiAgent.memoryRetrievalLimit ??= 6;
    this.config.store.aiAgent.memoryContextTokens ??= 1200;
    this.config.store.aiAgent.memoryEmbeddingProvider ??= "auto";
    this.config.store.aiAgent.memoryEmbeddingEndpoint ??= "http://127.0.0.1:8082";
    this.config.store.aiAgent.memoryEmbeddingModel ??= "Kibborg_Embed_v1";
    this.config.store.aiAgent.memoryEmbeddingDimensions ??= 0;
  }

  private normalizeEndpoint(value: string): string {
    return normalizeOpenAIBaseUrl(value);
  }

  private startEndpointCheckpoint(
    endpoint: string,
    apiToken: string,
    model: string,
  ): void {
    const sequence = ++this.endpointCheckpointSequence;
    if (!endpoint) {
      this.endpointCheckpointStatus = "empty";
      this.endpointCheckpointMessage = "Добавьте base URL для проверки endpoint.";
      return;
    }

    this.endpointCheckpointStatus = "checking";
    this.endpointCheckpointMessage = "Проверка endpoint...";
    void this.checkEndpoint(endpoint, apiToken, model, sequence);
  }

  private async checkEndpoint(
    endpoint: string,
    apiToken: string,
    model: string,
    sequence: number,
  ): Promise<void> {
    try {
      await checkpointLLMEndpoint(endpoint, apiToken, model);
      if (sequence !== this.endpointCheckpointSequence) {
        return;
      }

      this.endpointCheckpointStatus = "valid";
      this.endpointCheckpointMessage = "Endpoint принял проверочный запрос.";
    } catch (error) {
      if (sequence !== this.endpointCheckpointSequence) {
        return;
      }

      this.endpointCheckpointStatus = "invalid";
      this.endpointCheckpointMessage =
        error instanceof Error
          ? error.message
          : "Проверочный запрос к endpoint не удался.";
    }
  }

  private parseAdditionalRequestParameters(
    value: string,
  ):
    | { ok: true; value: Record<string, any> }
    | { ok: false; error: string } {
    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: true, value: {} };
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!this.isPlainObject(parsed)) {
        return {
          ok: false,
          error: "Дополнительные параметры запроса должны быть JSON-объектом.",
        };
      }

      return { ok: true, value: parsed };
    } catch {
      return {
        ok: false,
        error: "Дополнительные параметры запроса должны быть корректным JSON.",
      };
    }
  }

  private isPlainObject(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
