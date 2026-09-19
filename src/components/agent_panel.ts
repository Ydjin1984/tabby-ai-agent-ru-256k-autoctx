import {
  AfterViewInit,
  Component,
  Input,
  OnInit,
  OnDestroy,
  EventEmitter,
  Output,
  ViewChild,
  ElementRef,
} from "@angular/core";
import { ConfigService, HotkeysService } from "tabby-core";
import { BaseTerminalTabComponent, Frontend } from "tabby-terminal";
import { GetTerminalLinesTool } from "../lib/get_terminal_lines.tool";
import {
  buildSystemPrompt,
  LLMChatSession,
  LLMHistoryItem,
} from "../lib/llm_chat_session";
import { Tool, ToolExecutionState } from "../lib/tool_types";
import { RunShellCommandTool } from "../lib/run_shell_command.tool";
import { CancelCommandTool } from "../lib/cancel_command.tool";
import { TerminalContextService } from "../services/terminal_context.service";
import { AIAgentMemoryService } from "../services/ai_agent_memory.service";
import { AskUserTool } from "../lib/ask_user.tool";
import {
  detectOsName,
  detectShellFromProcess,
  detectShellFromProfile,
  detectShellFromText,
} from "../memory";
import {
  AUTO_COMPACT_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  formatTokens,
} from "../lib/context_usage";
import {
  CUSTOM_PRESET_ID,
  ReasoningEffort,
  isReasoningEffort,
  mergeReasoningParameters,
  resolveReasoningStyle,
} from "../lib/model_presets";
import { fetchContextWindow } from "../lib/llm_endpoint";
import { applyLocalRequestDefaults } from "../lib/request_defaults";
import {
  AutoApproveMaxRisk,
  canAutoApprove,
  detectDangerousCommand,
  isAutoApproveMaxRisk,
  normalizeRiskLevel,
} from "../lib/command_risk";
import { Subscription } from "rxjs";

type ChatRole = "user" | "assistant" | "reasoning" | "tool" | "system";
type ToolCallStatus =
  | "awaiting_approval"
  | "awaiting_user_input"
  | "awaiting_terminal_input"
  | "executing"
  | "blocked"
  | "completed"
  | "error";

interface ToolCallViewModel {
  id: string;
  name: string;
  args: any;
  status: ToolCallStatus;
  output: string | null;
  errorMessage: string | null;
  command: string | null;
  riskLevel: string | null;
  explanation: string | null;
  estimatedRunTime: string | null;
  question: string | null;
  choices: string[];
  outputCollapsed?: boolean;
}

interface PendingUserInputRequest {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  settled: boolean;
  draftAnswer: string;
  abortHandler?: () => void;
}

interface ChatMessageViewModel {
  id: string;
  role: ChatRole;
  content: string;
  streaming: boolean;
  collapsed?: boolean;
  toolCallIds?: string[];
  toolCallId?: string | null;
  /** data URLs прикреплённых изображений (для превью в ленте). */
  images?: string[];
}

interface AttachmentViewModel {
  id: string;
  name: string;
  kind: "image" | "text";
  dataUrl?: string;
  text?: string;
  size: number;
}

@Component({
  selector: "ai-agent-panel",
  templateUrl: "./agent_panel.html",
  styleUrls: ["./agent_panel.scss"],
})
export class AIPanelComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() frontend: Frontend | undefined;
  @Input() terminal: BaseTerminalTabComponent<any> | undefined;
  @Output() closed = new EventEmitter<void>();
  @Output() insertCommand = new EventEmitter<string>();
  @Output() executeCommand = new EventEmitter<string>();
  @ViewChild("messagesContainer")
  messagesContainer?: ElementRef<HTMLElement>;
  @ViewChild("promptInput")
  promptInput?: ElementRef<HTMLTextAreaElement>;
  @ViewChild("askUserInput")
  askUserInput?: ElementRef<HTMLInputElement>;
  @ViewChild("fileInput")
  fileInput?: ElementRef<HTMLInputElement>;

  private userIsNearBottom = true;
  /** Count of messages appended while auto-scroll was off (shown on the ↓ button). */
  missedMessagesCount = 0;
  private scrollFrameRequested = false;
  private autoScrollLoopActive = false;

  draftPrompt = "";
  /**
   * Timestamp of the last paste/insertion into the composer. Dictation tools and
   * clipboard pastes can deliver text as synthetic keystrokes; Enter presses that
   * arrive right after an insertion must not send the message.
   */
  private lastInsertAt = 0;
  attachments: AttachmentViewModel[] = [];
  messages: ChatMessageViewModel[] = [];
  toolCalls: ToolCallViewModel[] = [];
  sending = false;
  lastError: string | null = null;

  // Context usage meter
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  contextTokensUsed = 0;
  contextUsagePercent = 0;
  /** True when the value comes from the server's `usage`, false when estimated. */
  contextUsageExact = true;
  isCompacting = false;
  private lastCompactedAt: number | null = null;

  private chatSession: LLMChatSession | null = null;
  private currentAbortController: AbortController | null = null;
  private streamingAssistantMessageId: string | null = null;
  private streamingReasoningMessageId: string | null = null;
  private sessionTools: Tool[] = [];
  private pendingToolApprovals = new Map<
    string,
    {
      resolve: (approved: boolean) => void;
      settled: boolean;
    }
  >();
  private pendingUserInputs = new Map<string, PendingUserInputRequest>();
  private hotkeySubscription: Subscription | null = null;
  /** Settings that require a fresh chat session when they change. */
  private configSubscription: Subscription | null = null;
  private settingsSignature = "";

  constructor(
    private config: ConfigService,
    private terminalContext: TerminalContextService,
    private hotkeys: HotkeysService,
    private memoryService: AIAgentMemoryService,
  ) {}

  ngOnInit(): void {
    this.config.store.aiAgent ??= {};
    this.config.store.aiAgent.llmEndpoint ??= "";
    this.config.store.aiAgent.apiToken ??= "";
    this.config.store.aiAgent.model ??= "default";
    this.config.store.aiAgent.modelPreset ??= CUSTOM_PRESET_ID;
    if (!isReasoningEffort(this.config.store.aiAgent.reasoningEffort)) {
      this.config.store.aiAgent.reasoningEffort = "off";
    }
    this.config.store.aiAgent.autoApproveLowRiskCommands ??= false;
    this.config.store.aiAgent.autoApproveAllCommands ??= false;
    this.config.store.aiAgent.autoApproveMaxRisk ??= "none";
    this.config.store.aiAgent.additionalRequestParametersText ??= "";
    this.config.store.aiAgent.additionalRequestParameters ??= {};
    this.config.store.aiAgent.additionalSystemPrompt ??= "";
    this.config.store.aiAgent.hideTerminalOutput ??= false;
    this.config.store.aiAgent.memoryEnabled ??= true;
    this.config.store.aiAgent.memoryRetrievalLimit ??= 6;
    this.config.store.aiAgent.memoryContextTokens ??= 1200;
    this.config.store.aiAgent.memoryEmbeddingProvider ??= "auto";
    this.config.store.aiAgent.memoryEmbeddingEndpoint ??= "http://127.0.0.1:8082";
    this.config.store.aiAgent.memoryEmbeddingModel ??= "Kibborg_Embed_v1";
    this.config.store.aiAgent.memoryEmbeddingDimensions ??= 0;
    this.config.store.aiAgent.contextWindowTokens ??=
      DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.contextWindowTokens = Math.max(
      1024,
      Number(this.config.store.aiAgent.contextWindowTokens) ||
        DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    this.initializeSession();
    this.settingsSignature = this.currentSettingsSignature();
    this.refreshContextUsage();
    this.applyMemoryConfig();
    void this.updateMemoryEnvironment();
    void this.autodetectContextWindow();
    this.hotkeySubscription = this.hotkeys.hotkey$.subscribe((hotkey) => {
      if (hotkey === "force-read-terminal" && this.frontend) {
        this.terminalContext.forceReadFor(this.frontend);
      }
    });
    this.configSubscription = this.config.changed$.subscribe(() => {
      this.applyMemoryConfig();
      this.applySettingsChange();
    });
  }

  ngOnDestroy(): void {
    this.hotkeySubscription?.unsubscribe();
    this.hotkeySubscription = null;
    this.configSubscription?.unsubscribe();
    this.configSubscription = null;
    this.stopAutoScrollLoop();
    this.currentAbortController?.abort();
    this.cancelPendingApprovals();
    this.cancelPendingUserInputs();
    this.chatSession = null;
    void this.memoryService.manager.flush();
  }

  get endpointConfigured(): boolean {
    return Boolean(this.getEndpoint());
  }

  get canSend(): boolean {
    return (
      this.endpointConfigured &&
      Boolean(this.terminal) &&
      !this.sending &&
      (this.draftPrompt.trim().length > 0 || this.attachments.length > 0)
    );
  }

  async sendMessage(): Promise<void> {
    const prompt = this.draftPrompt.trim();
    if ((!prompt && this.attachments.length === 0) || this.sending) {
      return;
    }

    if (!this.endpointConfigured) {
      this.lastError =
        "Задайте LLM endpoint в настройках плагина перед началом чата.";
      return;
    }

    if (!this.terminal) {
      this.lastError =
        "Нет активной вкладки терминала для выполнения инструментов.";
      return;
    }

    if (!this.chatSession) {
      this.initializeSession();
    }

    if (!this.chatSession) {
      this.lastError = "Не удалось инициализировать сессию чата.";
      return;
    }

    this.lastError = null;
    this.sending = true;
    this.currentAbortController = new AbortController();
    this.draftPrompt = "";
    this.resetTextareaHeight();
    this.clearStreamingDrafts();

    const images = this.attachments
      .filter((a) => a.kind === "image" && a.dataUrl)
      .map((a) => a.dataUrl as string);
    const textParts = this.attachments
      .filter((a) => a.kind === "text")
      .map((a) => `--- Файл: ${a.name} ---\n${a.text}`);
    const userMessage = [prompt, ...textParts].filter(Boolean).join("\n\n");
    const attachmentNames = this.attachments.map((a) => a.name).join(", ");
    const displayContent = [prompt, attachmentNames ? `📎 ${attachmentNames}` : ""]
      .filter(Boolean)
      .join("\n");

    this.appendMessage({
      id: this.generateId("user"),
      role: "user",
      content: displayContent || (images.length ? "[изображение]" : ""),
      streaming: false,
      images: images.length ? images : undefined,
    });
    this.attachments = [];

    try {
      await this.chatSession.chat({
        userMessage,
        images: images.length ? images : undefined,
        silent: true,
        onToken: async (token) => {
          this.appendStreamingToken("assistant", token);
        },
        onReasoningToken: async (token) => {
          this.appendStreamingToken("reasoning", token);
        },
        onNotice: async (message) => {
          this.addSystemNotice(message);
        },
        onDiscardDraft: async () => {
          this.clearStreamingDrafts();
        },
        onPushHistory: async (message) => {
          this.commitHistoryMessage(message);
          this.refreshContextUsage();
        },
        onToolCall: async (toolCallId, toolName, args) => {
          const needsApproval = toolName === "run_shell_command";
          const needsUserInput = toolName === "ask_user";
          const autoApproved =
            needsApproval && this.shouldAutoApproveCommand(args);
          this.upsertToolCall(
            this.toToolCallViewModel(toolCallId, toolName, args, {
              status: needsUserInput
                ? "awaiting_user_input"
                : needsApproval
                ? autoApproved
                  ? "executing"
                  : "awaiting_approval"
                : "executing",
              output: needsUserInput
                ? "Ожидание ввода пользователя в панели агента."
                : needsApproval
                ? autoApproved
                  ? this.getAutoApprovalMessage(args)
                  : null
                : "Выполнение инструмента...",
              errorMessage: null,
            }),
          );

          if (!needsApproval) {
            return true;
          }

          if (autoApproved) {
            return true;
          }

          return await new Promise<boolean>((resolve) => {
            this.pendingToolApprovals.set(toolCallId, {
              resolve,
              settled: false,
            });
          });
        },
        onToolResult: async (toolCallId, toolName, args, output) => {
          const existingToolCall = this.toolCalls.find(
            (item) => item.id === toolCallId,
          );
          const executionState = this.getToolExecutionState(output);

          if (existingToolCall && executionState) {
            this.upsertToolCall({
              ...existingToolCall,
              status: executionState.status,
              output: executionState.output ?? null,
              errorMessage: null,
            });
            return;
          }

          this.upsertToolCall(
            this.toToolCallViewModel(toolCallId, toolName, args, {
              status: output.includes("not allowed") ? "blocked" : "completed",
              output,
              errorMessage: null,
            }),
          );
        },
        onToolError: async (
          toolCallId,
          _details,
          toolName,
          args,
          errorMessage,
        ) => {
          this.upsertToolCall(
            this.toToolCallViewModel(toolCallId, toolName, args, {
              status: "error",
              output: null,
              errorMessage,
            }),
          );
        },
        signal: this.currentAbortController.signal,
      });
    } catch (error) {
      if (this.isAbortError(error)) {
        this.finalizeStreamingDrafts();
        this.markActiveToolCallsStopped();
      } else {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.clearStreamingDrafts();
      }
    } finally {
      this.currentAbortController = null;
      this.sending = false;
      this.focusPrompt();
      this.refreshContextUsage();
      void this.maybeAutoCompact();
    }
  }

  stopCurrentResponse(): void {
    if (!this.sending) {
      return;
    }

    this.cancelPendingApprovals();
    if (this.hasExecutingShellCommand) {
      this.terminal?.sendInput("\x03");
    }
    this.currentAbortController?.abort();
    this.finalizeStreamingDrafts();
    this.markActiveToolCallsStopped();
    this.cancelPendingUserInputs();
  }

  /**
   * Dictation and clipboard insertion must survive an in-flight answer: the
   * prompt stays editable while the agent streams, only sending is blocked
   * (`canSend` still requires `!sending`).
   */
  handleComposerKeydown(event: KeyboardEvent): void {
    // Tabby's terminal "paste" hotkey must paste into the prompt, not the shell.
    if (this.isTerminalPasteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      void this.pasteFromClipboard();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    // A paste (or a dictation tool that "types" a multi-line result) can arrive
    // as synthetic Enter presses. Sending on those would swallow the text the
    // user just dictated, so right after an insertion Enter means "new line".
    if (event.isComposing || Date.now() - this.lastInsertAt < 300) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    void this.sendMessage();
  }

  /** Ctrl+Shift+V / Shift+Insert — the keystrokes Tabby maps to terminal paste. */
  private isTerminalPasteShortcut(event: KeyboardEvent): boolean {
    const key = event.key?.toLowerCase() ?? "";
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "v") {
      return true;
    }
    return event.shiftKey && key === "insert";
  }

  /**
   * Explicit paste handler: inserts the clipboard text at the caret ourselves
   * instead of trusting the default Electron path, which some dictation tools
   * (clipboard + synthetic Ctrl+V) and Tabby's own `paste` hotkey can bypass.
   */
  handleComposerPaste(event: ClipboardEvent): void {
    const textarea = this.promptInput?.nativeElement;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!textarea || !text) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.insertIntoComposer(textarea, text);
  }

  /**
   * Tabby binds "paste" to Ctrl+Shift+V / Shift+Insert for the terminal. With
   * the composer focused those keystrokes must paste into the prompt instead of
   * being forwarded to the shell behind the panel.
   */
  private async pasteFromClipboard(): Promise<void> {
    const textarea = this.promptInput?.nativeElement;
    if (!textarea) {
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        this.insertIntoComposer(textarea, text);
      }
    } catch {
      this.lastError = "Не удалось прочитать буфер обмена — вставьте текст обычным способом.";
    }
  }

  /** Insert `text` at the caret, keeping Angular's model in sync. */
  private insertIntoComposer(textarea: HTMLTextAreaElement, text: string): void {
    this.lastInsertAt = Date.now();
    textarea.focus();
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;

    if (typeof document !== "undefined" && document.execCommand) {
      textarea.setSelectionRange(start, end);
      try {
        if (document.execCommand("insertText", false, text)) {
          // ngModel updated through the native input event.
          this.draftPrompt = textarea.value;
          this.autoResizeTextarea();
          return;
        }
      } catch {
        // fall through to the manual path
      }
    }

    const next = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    this.draftPrompt = next;
    const caret = start + text.length;
    setTimeout(() => {
      textarea.selectionStart = caret;
      textarea.selectionEnd = caret;
    }, 0);
    this.autoResizeTextarea();
  }

  /**
   * Clicking anywhere in the panel that is not an interactive element moves the
   * caret into the composer, so dictation lands in the prompt rather than in the
   * terminal behind the panel.
   */
  onPanelMouseDown(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "button, a, input, textarea, select, .message, pre, code, .tool-call, .reasoning-content",
      )
    ) {
      return;
    }
    this.focusPrompt();
  }

  ngAfterViewInit(): void {
    this.focusPrompt();
  }

  handleContainerKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    for (const [hotkeyId, handler] of Object.entries(this.hotkeyHandlers)) {
      const keystrokes = (this.config.store as any).hotkeys?.[hotkeyId] as string[] | undefined;
      if (keystrokes?.length && keystrokes.some(k => this.matchKeystroke(k, event))) {
        event.preventDefault();
        handler();
        return;
      }
    }
  }

  private hotkeyHandlers: Record<string, () => void> = {
    'toggle-ai-agent-panel': () => this.closed.emit(),
    'approve-ai-agent-command': () => this.approveLastPendingCommand(),
    'decline-ai-agent-command': () => this.declineLastPendingCommand(),
    'stop-ai-agent-response': () => this.stopCurrentResponse(),
    'clear-ai-agent-chat': () => this.clearChat(),
    'force-read-terminal': () => {
      if (this.frontend) {
        this.terminalContext.forceReadFor(this.frontend);
      }
    },
  };

  private matchKeystroke(keystroke: string, event: KeyboardEvent): boolean {
    const parts = keystroke.split('-');
    if (parts.length < 2) return false;
    const key = parts.pop()!.toLowerCase();
    const hasCtrl = parts.includes('Ctrl');
    const hasMeta = parts.some(p => ['⌘', 'Win', 'Super', 'Meta'].includes(p));
    const hasAlt = parts.some(p => ['⌥', 'Alt'].includes(p));
    const hasShift = parts.includes('Shift');
    const eventKey = event.key?.toLowerCase();
    const codeKey = event.code?.replace(/^(Key|Digit|Arrow)/, '').toLowerCase();
    return (
      event.ctrlKey === hasCtrl &&
      event.altKey === hasAlt &&
      event.metaKey === hasMeta &&
      event.shiftKey === hasShift &&
      (eventKey === key || codeKey === key)
    );
  }

  autoResizeTextarea(): void {
    const textarea = this.promptInput?.nativeElement;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }

  openFilePicker(): void {
    this.fileInput?.nativeElement?.click();
  }

  async onFilesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    for (const file of files) {
      const attachment = await this.fileToAttachment(file);
      if (attachment) {
        this.attachments = [...this.attachments, attachment];
      }
    }
  }

  removeAttachment(id: string): void {
    this.attachments = this.attachments.filter((a) => a.id !== id);
  }

  private async fileToAttachment(
    file: File,
  ): Promise<AttachmentViewModel | null> {
    const id = this.generateId("attach");
    const name = file.name || "file";
    const size = file.size;
    const isImage =
      file.type.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);

    if (isImage) {
      if (file.size > 15 * 1024 * 1024) {
        this.lastError = `Файл «${name}» слишком большой для изображения (максимум 15 МБ).`;
        return null;
      }
      const dataUrl = await this.readFileAsDataUrl(file);
      return { id, name, kind: "image", dataUrl, size };
    }

    if (this.isTextFileName(name)) {
      if (file.size > 1024 * 1024) {
        this.lastError = `Файл «${name}» слишком большой для текста (максимум 1 МБ).`;
        return null;
      }
      const text = await this.readFileAsText(file);
      return { id, name, kind: "text", text, size };
    }

    return {
      id,
      name,
      kind: "text",
      text: `[Прикреплён файл: ${name} (${this.formatBytes(size)})]`,
      size,
    };
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  private isTextFileName(name: string): boolean {
    return /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|py|go|rs|c|h|cpp|hpp|cc|java|kt|sh|bash|zsh|bat|cmd|ps1|yaml|yml|toml|ini|cfg|conf|log|csv|tsv|html|htm|css|scss|less|sql|xml|vue|svelte|rb|php|pl|swift|r|dart|lua|gitignore|env|properties|diff|patch)$/i.test(
      name,
    );
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} МБ`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${bytes} Б`;
  }

  clearChat(): void {
    if (this.sending) {
      this.currentAbortController?.abort();
    }
    this.messages = [];
    this.toolCalls = [];
    this.lastError = null;
    this.missedMessagesCount = 0;
    this.clearStreamingDrafts();
    this.cancelPendingApprovals();
    this.cancelPendingUserInputs();
    this.initializeSession();
    this.refreshContextUsage();
  }

  approveToolCall(toolCallId: string): void {
    const approval = this.pendingToolApprovals.get(toolCallId);
    if (!approval || approval.settled) {
      return;
    }

    approval.settled = true;
    this.upsertToolCall({
      ...this.mustGetToolCall(toolCallId),
      status: "executing",
      output: "Команда одобрена. Отправка в терминал...",
      errorMessage: null,
    });
    approval.resolve(true);
    this.pendingToolApprovals.delete(toolCallId);
  }

  declineToolCall(toolCallId: string): void {
    const approval = this.pendingToolApprovals.get(toolCallId);
    if (!approval || approval.settled) {
      return;
    }

    approval.settled = true;
    this.upsertToolCall({
      ...this.mustGetToolCall(toolCallId),
      status: "blocked",
      output: "Команда отклонена пользователем.",
      errorMessage: null,
    });
    approval.resolve(false);
    this.pendingToolApprovals.delete(toolCallId);
  }

  approveLastPendingCommand(): void {
    const pending = this.toolCalls.find(
      (tc) => tc.status === "awaiting_approval",
    );
    if (pending) {
      this.approveToolCall(pending.id);
    }
  }

  declineLastPendingCommand(): void {
    const pending = this.toolCalls.find(
      (tc) => tc.status === "awaiting_approval",
    );
    if (pending) {
      this.declineToolCall(pending.id);
    }
  }

  submitUserAnswer(toolCallId: string, answer?: string): void {
    const request = this.pendingUserInputs.get(toolCallId);
    if (!request || request.settled) {
      return;
    }

    const toolCall = this.mustGetToolCall(toolCallId);
    const rawAnswer = answer ?? request.draftAnswer;
    const trimmedAnswer = rawAnswer.trim();

    if (!trimmedAnswer) {
      return;
    }

    this.upsertToolCall({
      ...toolCall,
      status: "executing",
      output: `User answered: ${trimmedAnswer}`,
      errorMessage: null,
    });
    request.resolve(trimmedAnswer);
  }

  updatePendingUserAnswer(toolCallId: string, value: string): void {
    const request = this.pendingUserInputs.get(toolCallId);
    if (!request || request.settled) {
      return;
    }

    request.draftAnswer = value;
  }

  getPendingUserAnswer(toolCallId: string): string {
    return this.pendingUserInputs.get(toolCallId)?.draftAnswer ?? "";
  }

  trackMessage(_index: number, message: ChatMessageViewModel): string {
    return message.id;
  }

  trackToolCall(_index: number, toolCall: ToolCallViewModel): string {
    return toolCall.id;
  }

  toggleMessageCollapsed(messageId: string): void {
    this.messages = this.messages.map((message) =>
      message.id === messageId
        ? { ...message, collapsed: !message.collapsed }
        : message,
    );
  }

  toggleToolCallOutputCollapsed(toolCallId: string): void {
    this.toolCalls = this.toolCalls.map((tc) =>
      tc.id === toolCallId
        ? { ...tc, outputCollapsed: !tc.outputCollapsed }
        : tc,
    );
  }

  getHotkeyLabel(hotkeyId: string): string {
    const keys = this.config.store.hotkeys?.[hotkeyId];
    return keys?.length ? keys[0].replace(/-/g, '+') : '';
  }

  formatToolArgs(args: any): string {
    try {
      return JSON.stringify(args ?? {}, null, 2);
    } catch {
      return String(args);
    }
  }

  getToolCalls(toolCallIds?: string[]): ToolCallViewModel[] {
    if (!toolCallIds?.length) {
      return [];
    }

    return toolCallIds
      .map((id) => this.toolCalls.find((toolCall) => toolCall.id === id))
      .filter((toolCall): toolCall is ToolCallViewModel => Boolean(toolCall));
  }

  private initializeSession(history?: LLMHistoryItem[]): void {
    const endpoint = this.getEndpoint();
    if (!endpoint || !this.terminal || !this.frontend) {
      this.chatSession = null;
      this.sessionTools = [];
      return;
    }

    this.sessionTools = [
      new GetTerminalLinesTool(this.frontend, this.terminalContext),
      new RunShellCommandTool(this.terminal, this.terminalContext),
      new CancelCommandTool(this.terminal),
      new AskUserTool((toolCallId, args, signal) =>
        this.requestUserAnswer(toolCallId, args, signal),
      ),
    ];

    this.chatSession = new LLMChatSession(
      endpoint,
      buildSystemPrompt(this.getAdditionalSystemPrompt()),
      this.sessionTools,
      this.getApiToken(),
      this.getModel(),
      this.getAdditionalRequestParameters(),
      history,
      this.memoryService.manager,
    );
  }

  /** Push the current memory toggles into the shared memory manager. */
  private applyMemoryConfig(): void {
    this.memoryService.applyConfig();
  }

  /** Detect the terminal environment and register it with the memory layer. */
  private async updateMemoryEnvironment(): Promise<void> {
    const terminal: any = this.terminal;
    const profile = terminal?.profile;
    const tail = this.frontend
      ? this.terminalContext.getLastNLines(this.frontend, 5)?.content ?? ""
      : "";
    const shell =
      detectShellFromProfile(profile) ||
      detectShellFromProcess() ||
      detectShellFromText(tail);

    let cwd = "";
    try {
      if (terminal?.session?.supportsWorkingDirectory?.()) {
        cwd = (await terminal.session.getWorkingDirectory()) ?? "";
      }
    } catch {
      cwd = "";
    }

    this.memoryService.manager.setEnvironment({
      os: detectOsName(),
      shell,
      cwd,
    });
  }

  /**
   * Fingerprint of the settings that change how a request is built. When the
   * user switches model or reasoning level, the session is rebuilt with the
   * dialogue carried over instead of silently keeping the old endpoint.
   */
  private currentSettingsSignature(): string {
    return JSON.stringify([
      this.getEndpoint(),
      this.getModel(),
      this.getApiToken(),
      this.getReasoningEffort(),
      this.getAdditionalRequestParameters(),
    ]);
  }

  private applySettingsChange(): void {
    const signature = this.currentSettingsSignature();
    if (signature === this.settingsSignature) {
      return;
    }
    this.settingsSignature = signature;

    const history = this.chatSession?.snapshotHistory();
    this.initializeSession(history);

    this.contextWindowTokens = Math.max(
      1024,
      Number(this.config.store.aiAgent?.contextWindowTokens) ||
        DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    this.refreshContextUsage();
    void this.autodetectContextWindow();
  }

  private getEndpoint(): string {
    return this.config.store.aiAgent?.llmEndpoint?.trim?.() ?? "";
  }

  /**
   * Auto-detect the real context window of a llama.cpp-compatible endpoint by
   * reading /props (n_ctx). Falls back to the configured value when the server
   * does not expose /props (e.g. OpenRouter or DeepSeek cloud).
   */
  private async autodetectContextWindow(): Promise<void> {
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      return;
    }
    const detected = await fetchContextWindow(endpoint);
    if (detected && detected > 0) {
      this.contextWindowTokens = detected;
      if (this.config.store.aiAgent) {
        this.config.store.aiAgent.contextWindowTokens = detected;
      }
      this.refreshContextUsage();
    }
  }

  private getAutoApproveMaxRisk(): AutoApproveMaxRisk {
    const aiAgent = this.config.store.aiAgent;
    const configured = aiAgent?.autoApproveMaxRisk;
    if (isAutoApproveMaxRisk(configured) && configured !== "none") {
      return configured;
    }
    // Back-compat with the original boolean toggles.
    if (aiAgent?.autoApproveAllCommands) {
      return "critical";
    }
    if (aiAgent?.autoApproveLowRiskCommands) {
      return "low";
    }
    return "none";
  }

  private shouldAutoApproveCommand(args: any): boolean {
    return canAutoApprove(
      String(args?.command ?? ""),
      args?.risk_level,
      this.getAutoApproveMaxRisk(),
    );
  }

  private getAutoApprovalMessage(args: any): string {
    const command = String(args?.command ?? "");
    const dangerous = detectDangerousCommand(command);
    if (dangerous.dangerous) {
      return `Команда одобрена автоматически (опасный класс: ${dangerous.reason}). Отправка в терминал...`;
    }
    if (this.getAutoApproveMaxRisk() === "none") {
      return "Команда одобрена автоматически. Отправка в терминал...";
    }
    const risk = normalizeRiskLevel(args?.risk_level);
    return `Команда одобрена автоматически (риск: ${risk}, лимит: ${this.getAutoApproveMaxRisk()}). Отправка в терминал...`;
  }

  private getAdditionalRequestParameters(): Record<string, any> {
    const params = this.config.store.aiAgent?.additionalRequestParameters;
    const base = this.isPlainObject(params) ? params : {};
    const endpoint = this.getEndpoint();
    const style = resolveReasoningStyle(
      endpoint,
      this.getModel(),
      this.config.store.aiAgent?.modelPreset,
    );
    const merged = mergeReasoningParameters(base, style, this.getReasoningEffort());
    // Local policy last: it strips switches the gateway cannot forward, removes
    // "unlimited thinking" budgets and fills in the sampling parameters the
    // Kibborg engine uses (without them the local brain loops).
    return applyLocalRequestDefaults(merged, endpoint, style);
  }

  private getReasoningEffort(): ReasoningEffort {
    const effort = this.config.store.aiAgent?.reasoningEffort;
    return isReasoningEffort(effort) ? effort : "off";
  }

  private getApiToken(): string {
    return this.config.store.aiAgent?.apiToken?.trim?.() ?? "";
  }

  private getModel(): string {
    return this.config.store.aiAgent?.model?.trim?.() || "default";
  }

  private getAdditionalSystemPrompt(): string {
    return this.config.store.aiAgent?.additionalSystemPrompt?.trim?.() ?? "";
  }

  private appendStreamingToken(
    role: "assistant" | "reasoning",
    token: string,
  ): void {
    const messageIdField =
      role === "assistant"
        ? "streamingAssistantMessageId"
        : "streamingReasoningMessageId";

    let messageId = this[messageIdField];
    if (!messageId) {
      messageId = this.generateId(role);
      this[messageIdField] = messageId;
      this.messages = [
        ...this.messages,
        {
          id: messageId,
          role,
          content: token,
          streaming: true,
          collapsed: role === "reasoning",
        },
      ];
      if (!this.userIsNearBottom) {
        this.missedMessagesCount++;
      }
    } else {
      this.messages = this.messages.map((message) =>
        message.id === messageId
          ? { ...message, content: `${message.content}${token}` }
          : message,
      );
    }

    this.scheduleScrollToBottom();
  }

  private commitHistoryMessage(message: LLMHistoryItem): void {
    if (message.role === "system" || message.role === "user") {
      return;
    }

    if (message.role === "assistant") {
      this.finalizeStreamingMessage(
        "assistant",
        this.historyContentToText(message.content),
        {
          toolCallIds: message.tool_calls?.map((toolCall) => toolCall.id) ?? [],
        },
      );
      return;
    }

    if (message.role === "reasoning") {
      this.finalizeStreamingMessage(
        "reasoning",
        this.historyContentToText(message.content),
      );
      return;
    }

    if (message.role === "tool") {
      const toolCallId = message.tool_call_id ?? null;
      if (toolCallId) {
        const existingToolCall = this.toolCalls.find(
          (item) => item.id === toolCallId,
        );
        if (existingToolCall) {
          this.upsertToolCall({
            ...existingToolCall,
            output: this.historyContentToText(message.content),
          });
        }
      }
    }
  }

  private finalizeStreamingMessage(
    role: "assistant" | "reasoning",
    content: string,
    extra: Partial<ChatMessageViewModel> = {},
  ): void {
    const messageId =
      role === "assistant"
        ? this.streamingAssistantMessageId
        : this.streamingReasoningMessageId;

    if (messageId) {
      this.messages = this.messages.map((message) =>
        message.id === messageId
          ? { ...message, content, streaming: false, ...extra }
          : message,
      );
      // The final content may be longer than what was streamed — re-anchor
      // to the bottom after Angular renders it.
      this.scheduleScrollToBottom();
    } else {
      this.appendMessage({
        id: this.generateId(role),
        role,
        content,
        streaming: false,
        collapsed: role === "reasoning",
        ...extra,
      });
    }

    if (role === "assistant") {
      this.streamingAssistantMessageId = null;
    } else {
      this.streamingReasoningMessageId = null;
    }
  }

  private appendMessage(message: ChatMessageViewModel): void {
    this.messages = [...this.messages, message];
    if (!this.userIsNearBottom) {
      this.missedMessagesCount++;
    }
    this.scheduleScrollToBottom();
  }

  private upsertToolCall(toolCall: ToolCallViewModel): void {
    const existingIndex = this.toolCalls.findIndex(
      (item) => item.id === toolCall.id,
    );
    if (existingIndex === -1) {
      this.toolCalls = [...this.toolCalls, toolCall];
    } else {
      const next = [...this.toolCalls];
      next[existingIndex] = {
        ...next[existingIndex],
        ...toolCall,
      };
      this.toolCalls = next;
    }

    this.scheduleScrollToBottom();
  }

  private toToolCallViewModel(
    id: string,
    name: string,
    args: any,
    state: Pick<ToolCallViewModel, "status" | "output" | "errorMessage">,
  ): ToolCallViewModel {
    return {
      id,
      name,
      args,
      status: state.status,
      output: state.output,
      errorMessage: state.errorMessage,
      outputCollapsed: true,
      command: this.getToolArg(args, "command"),
      riskLevel: this.getToolArg(args, "risk_level"),
      explanation: this.getToolArg(args, "explanation"),
      estimatedRunTime: this.getNumericToolArg(args, "estimated_run_time"),
      question: this.getToolArg(args, "question"),
      choices: this.getStringArrayToolArg(args, "choices"),
    };
  }

  private mustGetToolCall(toolCallId: string): ToolCallViewModel {
    const toolCall = this.toolCalls.find((item) => item.id === toolCallId);
    if (!toolCall) {
      throw new Error(`Tool call not found: ${toolCallId}`);
    }
    return toolCall;
  }

  private getToolExecutionState(output: string): ToolExecutionState | null {
    if (
      output === "Команда одобрена. Отправка в терминал..." ||
      output === "Ввод терминала получен. Ожидание завершения команды..."
    ) {
      return {
        status: "executing",
        output,
      };
    }

    if (
      output ===
      "Ожидание защищённого ввода в терминале. Перейдите на вкладку терминала и завершите ввод."
    ) {
      return {
        status: "awaiting_terminal_input",
        output,
      };
    }

    if (output === "Ожидание ввода пользователя в панели агента.") {
      return {
        status: "awaiting_user_input",
        output,
      };
    }

    return null;
  }

  private getToolArg(args: any, key: string): string | null {
    const value = args?.[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }

  private getStringArrayToolArg(args: any, key: string): string[] {
    const value = args?.[key];
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  }

  private isPlainObject(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  get hideTerminalOutput(): boolean {
    return !!this.config.store.aiAgent?.hideTerminalOutput;
  }

  private getNumericToolArg(args: any, key: string): string | null {
    const value = args?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${value} s`;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? `${parsed} s` : value.trim();
    }

    return null;
  }

  private historyContentToText(content: LLMHistoryItem["content"]): string {
    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }

          if (item?.type === "text") {
            return item.text ?? "";
          }

          if (item?.type === "image_url") {
            return "[image]";
          }

          return JSON.stringify(item);
        })
        .join("\n");
    }

    if (content == null) {
      return "";
    }

    return String(content);
  }

  private clearStreamingDrafts(): void {
    if (this.streamingAssistantMessageId) {
      this.messages = this.messages.filter(
        (message) => message.id !== this.streamingAssistantMessageId,
      );
      this.streamingAssistantMessageId = null;
    }

    if (this.streamingReasoningMessageId) {
      this.messages = this.messages.filter(
        (message) => message.id !== this.streamingReasoningMessageId,
      );
      this.streamingReasoningMessageId = null;
    }
  }

  private finalizeStreamingDrafts(): void {
    if (this.streamingAssistantMessageId) {
      this.messages = this.messages.map((message) =>
        message.id === this.streamingAssistantMessageId
          ? { ...message, streaming: false }
          : message,
      );
      this.streamingAssistantMessageId = null;
    }

    if (this.streamingReasoningMessageId) {
      this.messages = this.messages.map((message) =>
        message.id === this.streamingReasoningMessageId
          ? { ...message, streaming: false }
          : message,
      );
      this.streamingReasoningMessageId = null;
    }
  }

  private markActiveToolCallsStopped(): void {
    this.toolCalls = this.toolCalls.map((toolCall) =>
      toolCall.status === "awaiting_approval" ||
      toolCall.status === "awaiting_user_input" ||
      toolCall.status === "awaiting_terminal_input" ||
      toolCall.status === "executing"
        ? {
            ...toolCall,
            status: "blocked",
            output: toolCall.output
              ? `${toolCall.output}\nStopped by the user.`
              : "Остановлено пользователем.",
            errorMessage: null,
          }
        : toolCall,
    );
  }

  get hasExecutingShellCommand(): boolean {
    return this.toolCalls.some(
      (toolCall) =>
        toolCall.name === "run_shell_command" &&
        toolCall.status === "executing",
    );
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    );
  }

  private cancelPendingApprovals(): void {
    for (const approval of this.pendingToolApprovals.values()) {
      if (!approval.settled) {
        approval.settled = true;
        approval.resolve(false);
      }
    }
    this.pendingToolApprovals.clear();
  }

  private requestUserAnswer(
    toolCallId: string,
    args: { question: string; choices?: string[] },
    signal?: AbortSignal,
  ): Promise<string> {
    const toolCall = this.toolCalls.find((item) => item.id === toolCallId);
    if (
      !toolCall ||
      toolCall.name !== "ask_user" ||
      toolCall.question !== args.question
    ) {
      throw new Error("Unable to present ask_user prompt in the panel.");
    }

    return new Promise<string>((resolve, reject) => {
      const request: PendingUserInputRequest = {
        resolve: (answer) => {
          cleanup();
          resolve(answer);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        settled: false,
        draftAnswer: "",
      };

      const cleanup = () => {
        request.settled = true;
        if (request.abortHandler) {
          signal?.removeEventListener("abort", request.abortHandler);
        }
        this.pendingUserInputs.delete(toolCallId);
      };

      if (signal) {
        request.abortHandler = () => {
          request.reject(new DOMException("Operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", request.abortHandler, { once: true });
      }

      this.pendingUserInputs.set(toolCallId, request);
      this.scheduleScrollToBottom();
      setTimeout(() => this.askUserInput?.nativeElement?.focus(), 0);
    });
  }

  private cancelPendingUserInputs(): void {
    for (const request of this.pendingUserInputs.values()) {
      if (!request.settled) {
        request.reject(new DOMException("Operation was aborted.", "AbortError"));
      }
    }
    this.pendingUserInputs.clear();
  }

  private generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private resetTextareaHeight(): void {
    const textarea = this.promptInput?.nativeElement;
    if (textarea) {
      textarea.style.height = "38px";
    }
  }

  public focusPrompt(): void {
    setTimeout(() => this.promptInput?.nativeElement?.focus(), 0);
  }

  public onMessagesScroll(): void {
    const container = this.messagesContainer?.nativeElement;
    if (!container) return;
    const threshold = 60;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    this.userIsNearBottom = distanceFromBottom < threshold;
    if (this.userIsNearBottom) {
      this.missedMessagesCount = 0;
      this.startAutoScrollLoop();
    } else {
      this.stopAutoScrollLoop();
    }
  }

  /**
   * Live auto-scroll. `scheduleScrollToBottom` fires an immediate jump once
   * Angular has rendered the new messages (double requestAnimationFrame), and
   * additionally starts a per-frame "follow" loop that keeps the feed pinned
   * to the very bottom while auto-scroll is enabled. This covers deferred
   * rendering (markdown, tool cards, finalization), so the last lines are
   * always visible. The loop stops as soon as the user scrolls away.
   */
  private scheduleScrollToBottom(): void {
    this.startAutoScrollLoop();
    if (this.scrollFrameRequested) return;
    this.scrollFrameRequested = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.scrollFrameRequested = false;
        this.scrollToBottomIfNear();
      });
    });
  }

  private startAutoScrollLoop(): void {
    if (this.autoScrollLoopActive) return;
    this.autoScrollLoopActive = true;
    const tick = () => {
      if (!this.autoScrollLoopActive) return;
      const container = this.messagesContainer?.nativeElement;
      if (!container) {
        this.autoScrollLoopActive = false;
        return;
      }
      if (!this.userIsNearBottom) {
        this.autoScrollLoopActive = false;
        return;
      }
      // While auto-scroll is enabled, pin the feed to the very bottom on
      // every frame — regardless of how large the distance became. A big
      // block (final answer, tool output) must become visible immediately.
      if (container.scrollTop !== container.scrollHeight) {
        container.scrollTop = container.scrollHeight;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private stopAutoScrollLoop(): void {
    this.autoScrollLoopActive = false;
  }

  private scrollToBottomIfNear(): void {
    if (!this.userIsNearBottom) return;
    const container = this.messagesContainer?.nativeElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  /** True while auto-scroll is enabled (user is at/near the bottom). */
  get canAutoScroll(): boolean {
    return this.userIsNearBottom;
  }

  public scrollToBottomSmooth(): void {
    this.userIsNearBottom = true;
    this.missedMessagesCount = 0;
    const container = this.messagesContainer?.nativeElement;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
    this.scheduleScrollToBottom();
  }

  // ---------------------------------------------------------------
  // Context usage meter + compaction
  // ---------------------------------------------------------------

  get contextTokensDisplay(): string {
    return formatTokens(this.contextTokensUsed);
  }

  get contextWindowDisplay(): string {
    return formatTokens(this.contextWindowTokens);
  }

  get contextUsagePercentRounded(): number {
    return Math.round(this.contextUsagePercent * 100);
  }

  get contextUsagePercentClamped(): number {
    return Math.min(100, this.contextUsagePercentRounded);
  }

  get contextUsageClass(): "ok" | "warn" | "danger" {
    if (this.contextUsagePercent >= 0.85) return "danger";
    if (this.contextUsagePercent >= 0.6) return "warn";
    return "ok";
  }

  toolStatusLabel(status: ToolCallStatus): string {
    switch (status) {
      case "awaiting_approval":
        return "ожидает подтверждения";
      case "awaiting_user_input":
        return "ожидает ввода";
      case "awaiting_terminal_input":
        return "ожидает ввода терминала";
      case "executing":
        return "выполняется";
      case "blocked":
        return "заблокировано";
      case "completed":
        return "завершено";
      case "error":
        return "ошибка";
      default:
        return status;
    }
  }

  refreshContextUsage(): void {
    if (!this.chatSession) {
      this.contextTokensUsed = 0;
      this.contextUsagePercent = 0;
      this.contextUsageExact = true;
      return;
    }
    const { tokens, exact } = this.chatSession.getContextTokensForDisplay();
    this.contextTokensUsed = tokens;
    this.contextUsageExact = exact;
    this.contextUsagePercent =
      this.contextWindowTokens > 0 ? tokens / this.contextWindowTokens : 0;
  }

  /** Manual / auto compaction entry point. */
  async compactContext(auto = false): Promise<void> {
    if (!this.chatSession || this.isCompacting) {
      return;
    }
    this.isCompacting = true;
    try {
      const result = await this.chatSession.compactHistory();
      this.lastCompactedAt = Date.now();
      this.refreshContextUsage();
      this.addSystemNotice(
        auto
          ? `Контекст сжат автоматически при ${Math.round(
              AUTO_COMPACT_THRESHOLD * 100,
            )}% занятости: ${formatTokens(result.beforeTokens)} → ${formatTokens(
              result.afterTokens,
            )} токенов.`
          : `Контекст сжат: ${formatTokens(
              result.beforeTokens,
            )} → ${formatTokens(result.afterTokens)} токенов.`,
      );
    } catch (error) {
      if (this.isAbortError(error)) {
        return;
      }
      this.lastError = `Compaction failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      this.isCompacting = false;
    }
  }

  /** Run auto-compaction after a finished response when usage ≥ threshold. */
  private async maybeAutoCompact(): Promise<void> {
    if (this.sending || this.isCompacting || !this.chatSession) {
      return;
    }
    if (this.contextUsagePercent < AUTO_COMPACT_THRESHOLD) {
      return;
    }
    // Avoid endless loops when even the system prompt alone exceeds the threshold.
    if (
      this.lastCompactedAt !== null &&
      Date.now() - this.lastCompactedAt < 30_000
    ) {
      return;
    }
    await this.compactContext(true);
  }

  private addSystemNotice(text: string): void {
    this.appendMessage({
      id: this.generateId("system"),
      role: "system",
      content: text,
      streaming: false,
    });
  }
}
