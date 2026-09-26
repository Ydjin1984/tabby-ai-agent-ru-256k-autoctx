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
  HostListener,
} from "@angular/core";
import { ConfigService, HotkeysService } from "tabby-core";
import { BaseTerminalTabComponent, Frontend } from "tabby-terminal";
import { GetTerminalLinesTool } from "../lib/get_terminal_lines.tool";
import {
  buildSystemPrompt,
  LLMChatSession,
  LLMHistoryItem,
} from "../lib/llm_chat_session";
import { TOOL_PROGRESS_PREFIX, Tool, ToolExecutionState } from "../lib/tool_types";
import {
  clipAttachmentText,
  extractPdfText,
  looksLikeText,
} from "../lib/file_text";
import { RunShellCommandTool } from "../lib/run_shell_command.tool";
import { CancelCommandTool } from "../lib/cancel_command.tool";
import { TerminalContextService } from "../services/terminal_context.service";
import { AIAgentMemoryService } from "../services/ai_agent_memory.service";
import { AskUserTool } from "../lib/ask_user.tool";
import { WebSearchTool } from "../lib/web_search.tool";
import { WebFetchTool } from "../lib/web_fetch.tool";
import { DeepSearchTool } from "../lib/deep_search.tool";
import {
  DEFAULT_DEEP_SEARCH_PAGES,
  DEFAULT_WEB_CHAR_LIMIT,
  DEFAULT_WEB_SEARCH_RESULTS,
  DEFAULT_WEB_TIMEOUT_MS,
  WEB_SEARCH_ENGINES,
  WebSearchEngineInfo,
  WebToolsConfig,
  findWebSearchEngine,
  normalizeSearchProvider,
} from "../lib/web_client";
import webToolsSystemPrompt from "../prompts/web_tools_system_prompt.md";
import {
  DEFAULT_PANEL_THEME_ID,
  PANEL_THEMES,
  PanelTheme,
  findPanelTheme,
  isPanelThemeId,
} from "../lib/panel_themes";
import { wrapCodeForClipboard } from "../lib/markdown_renderer";
import { agentLog } from "../lib/debug_log";
import { createZip } from "../lib/zip";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
  ReasoningEffort,
  isReasoningEffort,
  mergeReasoningParameters,
  resolveReasoningStyle,
} from "../lib/model_presets";
import {
  DEFAULT_PROVIDER_ID,
  cloneProviders,
  findProvider,
} from "../lib/providers";
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
  /** Когда инструмент начал выполняться (для подсчёта длительности). */
  startedAt?: number | null;
  /** Сколько инструмент выполнялся, мс. */
  durationMs?: number | null;
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
  /** Сообщение-«хост»: несёт только карточки инструментов, без своего текста. */
  toolOnly?: boolean;
  /** Начало генерации ответа (для подсчёта длительности). */
  startedAt?: number;
  /** Длительность генерации ответа, мс. */
  durationMs?: number;
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
  /** Ключ сессионной памяти этой панели: своя память на каждую вкладку. */
  private memorySessionKey = "";
  /** Окружение (рабочий каталог) уже определено — повторные детекты не нужны. */
  private memoryEnvironmentResolved = false;
  /** Контекстное меню правой кнопки в полях ввода панели. */
  private composerContextMenuInstalled = false;
  private composerContextMenuElement: HTMLElement | null = null;
  private composerContextMenuHandler: ((event: MouseEvent) => void) | null = null;

  constructor(
    private config: ConfigService,
    private terminalContext: TerminalContextService,
    private hotkeys: HotkeysService,
    private memoryService: AIAgentMemoryService,
    private host: ElementRef<HTMLElement>,
  ) {}

  /** Доступные темы панели (расширяется в lib/panel_themes). */
  readonly panelThemes: PanelTheme[] = PANEL_THEMES;
  themeMenuOpen = false;
  readonly searchEngines: WebSearchEngineInfo[] = WEB_SEARCH_ENGINES;
  searchMenuOpen = false;
  /** id сообщения, для которого только что показали «Скопировано» (Markdown). */
  copiedMessageId: string | null = null;
  /** id сообщения, для которого только что скопировали обычный текст. */
  copiedTextMessageId: string | null = null;

  /** Время старта текущей команды — для индикатора «выполняется · N с». */
  private turnStartedAt = 0;
  /** Миллисекунды с начала выполнения команды (обновляется таймером 10 раз/с). */
  commandElapsedMs = 0;
  private executionTimer: ReturnType<typeof setInterval> | null = null;
  /** Сообщение-хост текущего хода, куда складываются карточки инструментов. */
  private toolHostMessageId: string | null = null;
  /** Каноническая карточка для повторных опросов get_terminal_lines. */
  private pollCardId: string | null = null;
  /** newToolCallId → канонический id (для схлопнутых повторов). */
  private toolCallAlias = new Map<string, string>();
  /** CSS-переменные, выставленные предыдущей темой — чтобы вернуть их при смене. */
  private appliedThemeVars: string[] = [];
  /** Кэш Electron-clipboard (самый надёжный путь копирования в рендерере). */
  private electronClipboard: { writeText(text: string): void } | null | undefined =
    undefined;

  ngOnInit(): void {
    this.config.store.aiAgent ??= {};
    this.ensureProviders();
    this.config.store.aiAgent.llmEndpoint ??= "";
    this.config.store.aiAgent.apiToken ??= "";
    this.config.store.aiAgent.model ??= "default";
    this.applyActiveProviderIfNeeded();
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
    this.config.store.aiAgent.webSearchEnabled ??= false;
    this.config.store.aiAgent.deepSearchEnabled ??= false;
    this.config.store.aiAgent.webSearchMaxResults ??= DEFAULT_WEB_SEARCH_RESULTS;
    this.config.store.aiAgent.deepSearchMaxPages ??= DEFAULT_DEEP_SEARCH_PAGES;
    this.config.store.aiAgent.webSearchTimeoutMs ??= DEFAULT_WEB_TIMEOUT_MS;
    this.config.store.aiAgent.webFetchCharLimit ??= DEFAULT_WEB_CHAR_LIMIT;
    this.config.store.aiAgent.webSearchProvider ??= "auto";
    if (!isPanelThemeId(this.config.store.aiAgent.panelTheme)) {
      this.config.store.aiAgent.panelTheme = DEFAULT_PANEL_THEME_ID;
    }
    this.config.store.aiAgent.contextWindowTokens ??=
      DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.contextWindowTokens = Math.max(
      1024,
      Number(this.config.store.aiAgent.contextWindowTokens) ||
        DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    this.initializeSession();
    this.warmSession();
    this.settingsSignature = this.currentSettingsSignature();
    this.refreshContextUsage();
    this.applyMemoryConfig();
    this.applyPanelTheme();
    void this.updateMemoryEnvironment();
    void this.autodetectContextWindow();
    this.hotkeySubscription = this.hotkeys.hotkey$.subscribe((hotkey) => {
      if (hotkey === "force-read-terminal" && this.frontend) {
        this.terminalContext.forceReadFor(this.frontend);
      }
    });
    this.configSubscription = this.config.changed$.subscribe(() => {
      this.applyMemoryConfig();
      this.applyPanelTheme();
      this.applySettingsChange();
    });
  }

  ngOnDestroy(): void {
    this.hotkeySubscription?.unsubscribe();
    this.hotkeySubscription = null;
    this.configSubscription?.unsubscribe();
    this.configSubscription = null;
    this.stopAutoScrollLoop();
    this.stopExecutionTimer();
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

    // Окружение (рабочий каталог) могло не определиться при открытии панели —
    // добираем его перед первым рабочим запросом, иначе «память проекта» и привязка
    // записей к каталогу остаются пустыми на всю жизнь панели.
    if (!this.memoryEnvironmentResolved) {
      await this.updateMemoryEnvironment();
    }

    this.lastError = null;
    this.sending = true;
    this.currentAbortController = new AbortController();
    this.draftPrompt = "";
    this.resetTextareaHeight();
    this.clearStreamingDrafts();
    this.resetTurnGrouping();

    const attached = this.attachments.slice();
    const images = attached
      .filter((a) => a.kind === "image" && a.dataUrl)
      .map((a) => a.dataUrl as string);
    const imageNames = attached
      .filter((a) => a.kind === "image")
      .map((a) => a.name);
    const textParts: string[] = [];
    const displayNotes: string[] = [];
    for (const file of attached) {
      if (file.kind === "image") {
        displayNotes.push(`📎 ${file.name} — картинка передана в контекст`);
        continue;
      }
      const clipped = clipAttachmentText(file.text ?? "");
      textParts.push(`--- Файл: ${file.name} ---\n${clipped.text}`);
      displayNotes.push(
        `📎 ${file.name} — в контексте ${clipped.text.length} символов${
          clipped.clipped ? " (файл длиннее, переданы начало и конец)" : ""
        }`,
      );
    }
    const preface = attached.length
      ? "Пользователь прикрепил файлы к этому сообщению. Сначала опирайся на их содержимое. Не пиши, что вложений не было."
      : "";
    const imageNote = imageNames.length
      ? `Картинки в этом сообщении: ${imageNames.join(", ")}. Они переданы как изображения. Если пиксели тебе недоступны, скажи об этом прямо и не выдумывай содержимое.`
      : "";
    const userMessage = [prompt, preface, imageNote, ...textParts]
      .filter((part) => part && part.trim())
      .join("\n\n");
    agentLog("attachments", {
      count: attached.length,
      images: imageNames.length,
      userChars: userMessage.length,
      files: attached.map((file) => ({
        name: file.name,
        kind: file.kind,
        chars: file.kind === "text" ? (file.text ?? "").length : file.dataUrl?.length ?? 0,
      })),
    });
    const displayContent = [prompt, ...displayNotes].filter(Boolean).join("\n");

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

          // Повторные опросы терминала схлопываем в одну карточку: за длинную
          // команду модель иначе плодит десятки одинаковых блоков.
          let cardId = toolCallId;
          if (toolName === "get_terminal_lines") {
            if (
              this.pollCardId &&
              this.toolCalls.some((item) => item.id === this.pollCardId)
            ) {
              cardId = this.pollCardId;
              this.toolCallAlias.set(toolCallId, cardId);
            } else {
              this.pollCardId = toolCallId;
            }
          }

          this.upsertToolCall(
            this.toToolCallViewModel(cardId, toolName, args, {
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
                : toolName === "get_terminal_lines"
                  ? "Чтение вывода терминала…"
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
            this.pendingToolApprovals.set(cardId, {
              resolve,
              settled: false,
            });
          });
        },
        onToolResult: async (toolCallId, toolName, args, output) => {
          toolCallId = this.canonicalToolCallId(toolCallId);
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
            this.toToolCallViewModel(
              this.canonicalToolCallId(toolCallId),
              toolName,
              args,
              {
                status: "error",
                output: null,
                errorMessage,
              },
            ),
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
        agentLog("turn_error", {
          message: this.lastError,
          stack: error instanceof Error ? error.stack : undefined,
        });
        this.clearStreamingDrafts();
      }
    } finally {
      this.currentAbortController = null;
      this.sending = false;
      this.stopExecutionTimer();
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
    this.stopExecutionTimer();
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
    this.installComposerContextMenu();
  }

  /**
   * Правое меню в полях ввода панели (промпт агента и поле ответа ask_user).
   * Tabby не показывает контекстное меню для элементов внутри панели, поэтому
   * рисуем своё: Вырезать / Копировать / Вставить / Выделить всё. Обработчик висит
   * на document в фазе перехвата, но реагирует только на поля панели — терминал и
   * остальной интерфейс не затрагиваются.
   */
  private installComposerContextMenu(): void {
    if (this.composerContextMenuInstalled || typeof document === "undefined") {
      return;
    }
    this.composerContextMenuInstalled = true;
    this.composerContextMenuHandler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const field = target?.closest?.(
        ".ai-panel-container textarea, .ai-panel-container input[type='text']",
      ) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!field) {
        return;
      }
      this.openComposerContextMenu(event, field);
    };
    document.addEventListener("contextmenu", this.composerContextMenuHandler, true);
  }

  private closeComposerContextMenu(): void {
    if (this.composerContextMenuElement) {
      this.composerContextMenuElement.remove();
      this.composerContextMenuElement = null;
    }
  }

  private openComposerContextMenu(
    event: MouseEvent,
    field: HTMLInputElement | HTMLTextAreaElement,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeComposerContextMenu();

    const start = typeof field.selectionStart === "number" ? field.selectionStart : 0;
    const end = typeof field.selectionEnd === "number" ? field.selectionEnd : 0;
    const hasSelection = start !== end;
    const items = [
      { id: "cut", label: "Вырезать", enabled: hasSelection },
      { id: "copy", label: "Копировать", enabled: hasSelection },
      { id: "paste", label: "Вставить", enabled: true },
      { id: "selectAll", label: "Выделить всё", enabled: Boolean(field.value) },
    ];

    const menu = document.createElement("div");
    menu.className = "ai-agent-context-menu";
    Object.assign(menu.style, {
      position: "fixed",
      zIndex: "10000",
      minWidth: "168px",
      padding: "4px",
      border: "1px solid var(--theme-border, #3a3f4b)",
      borderRadius: "8px",
      background: "var(--theme-bg-more, #22262e)",
      boxShadow: "0 6px 24px rgba(0,0,0,.45)",
      fontSize: "13px",
      color: "var(--theme-fg, #dfe3ea)",
      userSelect: "none",
    });

    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.textContent = item.label;
      Object.assign(row.style, {
        display: "block",
        width: "100%",
        padding: "6px 10px",
        border: "0",
        borderRadius: "6px",
        background: "transparent",
        color: "inherit",
        textAlign: "left",
        fontSize: "13px",
        cursor: item.enabled ? "pointer" : "default",
        opacity: item.enabled ? "1" : ".45",
      });
      if (item.enabled) {
        row.addEventListener("mouseenter", () => {
          row.style.background = "var(--theme-bg, #2c313a)";
        });
        row.addEventListener("mouseleave", () => {
          row.style.background = "transparent";
        });
        row.addEventListener("mousedown", (mouseEvent) => {
          mouseEvent.preventDefault();
          mouseEvent.stopPropagation();
        });
        row.addEventListener("click", (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          this.applyComposerMenuAction(item.id, field);
        });
      }
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    const left = Math.min(event.clientX, Math.max(0, window.innerWidth - menu.offsetWidth - 8));
    const top = Math.min(event.clientY, Math.max(0, window.innerHeight - menu.offsetHeight - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    this.composerContextMenuElement = menu;

    const dismiss = (dismissEvent: Event) => {
      if (dismissEvent.type === "mousedown" && menu.contains(dismissEvent.target as Node)) {
        return;
      }
      if (dismissEvent.type === "keydown" && (dismissEvent as KeyboardEvent).key !== "Escape") {
        return;
      }
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("blur", dismiss, true);
      this.closeComposerContextMenu();
    };
    setTimeout(() => {
      document.addEventListener("mousedown", dismiss, true);
      document.addEventListener("keydown", dismiss, true);
      window.addEventListener("blur", dismiss, true);
    }, 0);
  }

  private applyComposerMenuAction(
    action: string,
    field: HTMLInputElement | HTMLTextAreaElement,
  ): void {
    this.closeComposerContextMenu();
    const start = typeof field.selectionStart === "number" ? field.selectionStart : field.value.length;
    const end = typeof field.selectionEnd === "number" ? field.selectionEnd : start;
    const selected = field.value.slice(start, end);

    const notifyModel = () => {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const insertText = (text: string) => {
      field.value = field.value.slice(0, start) + text + field.value.slice(end);
      const caret = start + text.length;
      try {
        field.setSelectionRange(caret, caret);
      } catch {
        // поле может не поддерживать выделение — не критично
      }
      this.lastInsertAt = Date.now();
      notifyModel();
      if (field.tagName === "TEXTAREA") {
        this.autoResizeTextarea();
      }
    };
    const copySelection = () => {
      if (!selected) {
        return;
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(selected).catch(() => undefined);
        return;
      }
      try {
        document.execCommand("copy");
      } catch {
        // буфер обмена недоступен
      }
    };

    field.focus();
    if (action === "copy") {
      copySelection();
      return;
    }
    if (action === "cut") {
      copySelection();
      if (selected) {
        insertText("");
      }
      return;
    }
    if (action === "selectAll") {
      field.setSelectionRange(0, field.value.length);
      return;
    }
    if (action === "paste") {
      if (navigator.clipboard?.readText) {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              insertText(text);
            }
          })
          .catch(() => {
            this.lastError = "Не удалось прочитать буфер обмена — используйте Ctrl+V.";
          });
        return;
      }
      try {
        document.execCommand("paste");
      } catch {
        this.lastError = "Вставка недоступна — используйте Ctrl+V.";
      }
    }
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

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(name);
    if (isPdf) {
      if (file.size > 15 * 1024 * 1024) {
        this.lastError = `Файл «${name}» слишком большой для PDF (максимум 15 МБ).`;
        return null;
      }
      const bytes = await this.readFileAsBytes(file);
      const extracted = extractPdfText(bytes);
      const text = extracted
        ? extracted
        : `[PDF «${name}» прикреплён (${this.formatBytes(size)}), но текстовый слой не извлечён. Это может быть скан.]`;
      return { id, name, kind: "text", text, size };
    }

    if (file.size > 1024 * 1024) {
      this.lastError = `Файл «${name}» слишком большой для текста (максимум 1 МБ).`;
      return null;
    }
    const raw = await this.readFileAsText(file);
    if (this.isTextFileName(name) || file.type.startsWith("text/") || looksLikeText(raw)) {
      return { id, name, kind: "text", text: raw, size };
    }

    return {
      id,
      name,
      kind: "text",
      text: `[Прикреплён файл: ${name} (${this.formatBytes(size)}). Содержимое не текстовое и в контекст не попало.]`,
      size,
    };
  }

  private readFileAsBytes(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
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
    this.stopExecutionTimer();
    this.resetTurnGrouping();
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

  trackTheme(_index: number, theme: PanelTheme): string {
    return theme.id;
  }

  trackEngine(_index: number, engine: WebSearchEngineInfo): string {
    return engine.id;
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

    const tools: Tool[] = [
      new GetTerminalLinesTool(
        this.frontend,
        this.terminalContext,
        () => this.hasExecutingShellCommand,
      ),
      new RunShellCommandTool(this.terminal, this.terminalContext),
      new CancelCommandTool(this.terminal),
    ];

    const webConfig: WebToolsConfig = {
      maxResults: () => this.getWebSearchMaxResults(),
      maxPages: () => this.getDeepSearchMaxPages(),
      timeoutMs: () => this.getWebSearchTimeoutMs(),
      charLimit: () => this.getWebFetchCharLimit(),
      provider: () => this.webSearchProvider,
    };
    if (this.deepSearchEnabled) {
      tools.push(new DeepSearchTool(webConfig));
    }
    if (this.webSearchEnabled || this.deepSearchEnabled) {
      tools.push(new WebFetchTool(webConfig));
    }
    if (this.webSearchEnabled) {
      tools.push(new WebSearchTool(webConfig));
    }
    tools.push(
      new AskUserTool((toolCallId, args, signal) =>
        this.requestUserAnswer(toolCallId, args, signal),
      ),
    );
    this.sessionTools = tools;

    // Каждая панель ведёт собственную сессионную память: иначе goal/attempts двух
    // вкладок смешивались, а окружение одной панели переписывало окружение другой.
    this.memorySessionKey = this.memorySessionKey || this.generateId("panel");
    this.memoryService.manager.setSessionKey(this.memorySessionKey);

    this.chatSession = new LLMChatSession(
      endpoint,
      buildSystemPrompt(this.buildAdditionalSystemPrompt()),
      this.sessionTools,
      this.getApiToken(),
      this.getModel(),
      this.getAdditionalRequestParameters(),
      history,
      this.memoryService.manager,
    );
    this.chatSession.setContextWindowTokens(this.contextWindowTokens);
  }

  /** Прогрев кэша префикса на локальном Киборге. Ошибка прогрева чат не ломает. */
  private warmSession(): void {
    void this.chatSession?.warmup().catch((error) => {
      agentLog("warmup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
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
    // Каталог может быть ещё не готов при старте панели: если он получен, повторные
    // детекты больше не нужны, иначе пробуем при следующем запросе.
    this.memoryEnvironmentResolved = Boolean(cwd);
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
      this.webSearchEnabled,
      this.deepSearchEnabled,
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
    this.warmSession();

    this.contextWindowTokens = Math.max(
      1024,
      Number(this.config.store.aiAgent?.contextWindowTokens) ||
        DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    this.chatSession?.setContextWindowTokens(this.contextWindowTokens);
    this.refreshContextUsage();
    void this.autodetectContextWindow();
  }

  private getEndpoint(): string {
    return this.config.store.aiAgent?.llmEndpoint?.trim?.() ?? "";
  }

  /** Заводит список провайдеров и активного провайдера, если их ещё нет. */
  private ensureProviders(): void {
    const aiAgent = this.config.store.aiAgent;
    if (!Array.isArray(aiAgent.providers)) {
      aiAgent.providers = cloneProviders();
    }
    if (typeof aiAgent.activeProviderId !== "string") {
      aiAgent.activeProviderId = DEFAULT_PROVIDER_ID;
    }
    const active = findProvider(aiAgent.providers, aiAgent.activeProviderId);
    if (!active) {
      aiAgent.activeProviderId = aiAgent.providers[0]?.id ?? "";
    }
  }

  /**
   * Если активный провайдер задан, а эффективные поля пусты (свежий конфиг),
   * подставляем его endpoint/model/token.
   */
  private applyActiveProviderIfNeeded(): void {
    const aiAgent = this.config.store.aiAgent;
    const provider = findProvider(aiAgent.providers, aiAgent.activeProviderId);
    if (!provider) {
      return;
    }
    if (!aiAgent.llmEndpoint) {
      aiAgent.llmEndpoint = provider.endpoint;
    }
    if (!aiAgent.apiToken) {
      aiAgent.apiToken = provider.apiToken;
    }
    if (!aiAgent.model || aiAgent.model === "default") {
      aiAgent.model = provider.model;
    }
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
      this.chatSession?.setContextWindowTokens(detected);
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
    const style = resolveReasoningStyle(endpoint, this.getModel());
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

  /**
   * Дополнительный промпт = пользовательский + правила интернет-инструментов,
   * когда они включены. Стиль ответа добавляет `buildSystemPrompt` поверх.
   */
  private buildAdditionalSystemPrompt(): string {
    const parts: string[] = [];
    const userPrompt = this.getAdditionalSystemPrompt();
    if (userPrompt) {
      parts.push(userPrompt);
    }
    if (this.webSearchEnabled || this.deepSearchEnabled) {
      const webPrompt = String(webToolsSystemPrompt ?? "").trim();
      if (webPrompt) {
        parts.push(webPrompt);
      }
    }
    return parts.join("\n\n");
  }

  get webSearchEnabled(): boolean {
    return !!this.config.store.aiAgent?.webSearchEnabled;
  }

  get deepSearchEnabled(): boolean {
    return !!this.config.store.aiAgent?.deepSearchEnabled;
  }

  private clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    const base = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    return Math.max(min, Math.min(max, Math.floor(base)));
  }

  getWebSearchMaxResults(): number {
    return this.clampNumber(
      this.config.store.aiAgent?.webSearchMaxResults,
      DEFAULT_WEB_SEARCH_RESULTS,
      1,
      15,
    );
  }

  getDeepSearchMaxPages(): number {
    return this.clampNumber(
      this.config.store.aiAgent?.deepSearchMaxPages,
      DEFAULT_DEEP_SEARCH_PAGES,
      1,
      10,
    );
  }

  getWebSearchTimeoutMs(): number {
    return this.clampNumber(
      this.config.store.aiAgent?.webSearchTimeoutMs,
      DEFAULT_WEB_TIMEOUT_MS,
      1000,
      60000,
    );
  }

  getWebFetchCharLimit(): number {
    return this.clampNumber(
      this.config.store.aiAgent?.webFetchCharLimit,
      DEFAULT_WEB_CHAR_LIMIT,
      500,
      20000,
    );
  }

  /** Включить/выключить быстрый веб-поиск; сессия пересобирается с новыми тулами. */
  async toggleWebSearch(): Promise<void> {
    const next = !this.webSearchEnabled;
    this.config.store.aiAgent.webSearchEnabled = next;
    this.addSystemNotice(
      next
        ? "Веб-поиск включён: агенту доступен инструмент web_search."
        : "Веб-поиск выключен.",
    );
    await this.config.save();
    this.applySettingsChange();
  }

  /** Включить/выключить глубокий ресёрч (deep_search + web_fetch). */
  async toggleDeepSearch(): Promise<void> {
    const next = !this.deepSearchEnabled;
    this.config.store.aiAgent.deepSearchEnabled = next;
    this.addSystemNotice(
      next
        ? "Глубокий поиск включён: агенту доступны deep_search и web_fetch."
        : "Глубокий поиск выключен.",
    );
    await this.config.save();
    this.applySettingsChange();
  }

  // ---------------------------------------------------------------
  // Тема панели
  // ---------------------------------------------------------------

  get currentThemeId(): string {
    const id = this.config.store.aiAgent?.panelTheme;
    return isPanelThemeId(id) ? id : DEFAULT_PANEL_THEME_ID;
  }

  get currentTheme(): PanelTheme {
    return findPanelTheme(this.currentThemeId);
  }

  /** Применяет выбранную тему: CSS-переменные + класс структурного режима. */
  applyPanelTheme(): void {
    const el = this.host?.nativeElement;
    if (!el) {
      return;
    }
    for (const key of this.appliedThemeVars) {
      el.style.removeProperty(key);
    }
    this.appliedThemeVars = [];

    const theme = this.currentTheme;
    for (const [key, value] of Object.entries(theme.vars)) {
      el.style.setProperty(key, value);
      this.appliedThemeVars.push(key);
    }
    el.classList.toggle("mode-log", theme.mode === "log");
    el.classList.toggle("mode-cards", theme.mode !== "log");
  }

  toggleThemeMenu(event?: Event): void {
    event?.stopPropagation();
    this.themeMenuOpen = !this.themeMenuOpen;
    if (this.themeMenuOpen) {
      this.searchMenuOpen = false;
    }
  }

  async selectTheme(id: string): Promise<void> {
    if (!isPanelThemeId(id)) {
      return;
    }
    this.themeMenuOpen = false;
    this.config.store.aiAgent.panelTheme = id;
    this.applyPanelTheme();
    await this.config.save();
  }

  // ---------------------------------------------------------------
  // Выбор поискового движка
  // ---------------------------------------------------------------

  get webSearchProvider(): string {
    return normalizeSearchProvider(this.config.store.aiAgent?.webSearchProvider);
  }

  get currentSearchEngine(): WebSearchEngineInfo {
    return findWebSearchEngine(this.webSearchProvider);
  }

  toggleSearchMenu(event?: Event): void {
    event?.stopPropagation();
    this.searchMenuOpen = !this.searchMenuOpen;
    if (this.searchMenuOpen) {
      this.themeMenuOpen = false;
    }
  }

  async selectSearchProvider(id: string): Promise<void> {
    this.searchMenuOpen = false;
    this.config.store.aiAgent.webSearchProvider = normalizeSearchProvider(id);
    await this.config.save();
  }

  onPanelClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target as HTMLElement | null;
    if (!target?.closest?.(".theme-picker")) {
      this.themeMenuOpen = false;
    }
    if (!target?.closest?.(".search-picker")) {
      this.searchMenuOpen = false;
    }
  }

  @HostListener("document:click")
  onDocumentClick(): void {
    this.themeMenuOpen = false;
    this.searchMenuOpen = false;
  }

  // ---------------------------------------------------------------
  // Копирование
  // ---------------------------------------------------------------

  /**
   * Electron clipboard из рендерера — самый надёжный путь (writeText браузерного
   * Clipboard API в Electron иногда молча отклоняется без фокуса документа).
   */
  private getElectronClipboard(): { writeText(text: string): void } | null {
    if (this.electronClipboard !== undefined) {
      return this.electronClipboard;
    }
    let resolved: { writeText(text: string): void } | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require("electron");
      resolved = electron?.clipboard ?? null;
    } catch {
      resolved = null;
    }
    this.electronClipboard = resolved;
    return resolved;
  }

  async copyToClipboard(text: string): Promise<boolean> {
    if (!text) {
      return false;
    }

    const electronClipboard = this.getElectronClipboard();
    if (electronClipboard?.writeText) {
      try {
        electronClipboard.writeText(text);
        return true;
      } catch {
        // переходим к браузерному способу
      }
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // переходим к запасному способу
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /** Копирует исходный Markdown ответа ассистента (с ```-фенсами и таблицами). */
  async copyAssistantMarkdown(message: ChatMessageViewModel): Promise<void> {
    const ok = await this.copyToClipboard(message.content ?? "");
    if (ok) {
      this.copiedMessageId = message.id;
      setTimeout(() => {
        if (this.copiedMessageId === message.id) {
          this.copiedMessageId = null;
        }
      }, 1200);
    }
  }

  /** Копирует ответ ассистента как обычный текст (без разметки Markdown). */
  async copyAssistantText(message: ChatMessageViewModel): Promise<void> {
    const root = this.host?.nativeElement?.querySelector(
      `.message[data-message-id="${message.id}"] .markdown-content`,
    ) as HTMLElement | null;
    const text = root?.innerText?.trim() || stripMarkdown(message.content ?? "");
    const ok = await this.copyToClipboard(text);
    if (ok) {
      this.copiedTextMessageId = message.id;
      setTimeout(() => {
        if (this.copiedTextMessageId === message.id) {
          this.copiedTextMessageId = null;
        }
      }, 1200);
    }
  }

  // ---------------------------------------------------------------
  // Экспорт сессии в ZIP
  // ---------------------------------------------------------------

  private getElectronDialog(): {
    showSaveDialog(options: any): Promise<any>;
  } | null {
    try {
      const remote = require("@electron/remote");
      if (remote?.dialog?.showSaveDialog) {
        return remote.dialog;
      }
    } catch {
      // нет @electron/remote
    }
    try {
      const electron = require("electron");
      if (electron?.dialog?.showSaveDialog) {
        return electron.dialog;
      }
    } catch {
      // нет electron
    }
    return null;
  }

  /** Сохраняет всю историю сессии в ZIP (session.json + session.md). */
  async exportSession(): Promise<void> {
    try {
      const history = this.chatSession?.getHistory() ?? [];
      const toolCalls = this.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        status: toolCall.status,
        args: toolCall.args,
        command: toolCall.command,
        riskLevel: toolCall.riskLevel,
        explanation: toolCall.explanation,
        question: toolCall.question,
        choices: toolCall.choices,
        output: toolCall.output,
        errorMessage: toolCall.errorMessage,
      }));

      const entries = this.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        streaming: message.streaming,
        toolCallIds: message.toolCallIds ?? [],
        images: message.images?.length ? message.images.length : 0,
      }));

      const payload = {
        exportedAt: new Date().toISOString(),
        plugin: "tabby-ai-agent",
        model: this.getModel(),
        endpoint: this.getEndpoint(),
        panelTheme: this.currentThemeId,
        messageCount: this.messages.length,
        toolCallCount: toolCalls.length,
        messages: entries,
        toolCalls,
        history,
      };

      const json = JSON.stringify(payload, null, 2);
      const markdown = this.buildSessionMarkdown(payload);
      const archive = createZip([
        { name: "session.json", content: json },
        { name: "session.md", content: markdown },
      ]);

      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      const filename = `tabby-ai-agent-session-${stamp}.zip`;
      const dir = path.join(os.homedir(), ".tabby-ai-agent", "sessions");
      fs.mkdirSync(dir, { recursive: true });
      const defaultPath = path.join(dir, filename);

      const chosen = await this.pickExportPath(defaultPath);
      if (chosen === null) {
        return;
      }
      const target = chosen || defaultPath;
      fs.writeFileSync(target, archive);
      agentLog("session_exported", {
        path: target,
        bytes: archive.length,
        messages: this.messages.length,
      });
      this.addSystemNotice(
        `Сессия сохранена в ZIP: ${target} (${Math.max(1, Math.round(archive.length / 1024))} КБ)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `Не удалось сохранить сессию: ${message}`;
      agentLog("session_export_error", { message });
    }
  }

  private async pickExportPath(defaultPath: string): Promise<string | null> {
    const dialog = this.getElectronDialog();
    if (!dialog) {
      return defaultPath;
    }
    try {
      const result = await dialog.showSaveDialog({
        title: "Сохранить сессию AI-агента",
        defaultPath,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (!result || result.canceled) {
        return null;
      }
      return result.filePath || defaultPath;
    } catch {
      return defaultPath;
    }
  }

  private buildSessionMarkdown(payload: {
    exportedAt: string;
    model: string;
    endpoint: string;
    panelTheme: string;
    messages: Array<{ role: string; content: string }>;
    toolCalls: Array<{ id: string; name: string; status: string; output: string | null; errorMessage: string | null }>;
  }): string {
    const lines: string[] = [
      "# AI Agent — история сессии",
      "",
      `- Экспортировано: ${payload.exportedAt}`,
      `- Модель: ${payload.model || "—"}`,
      `- Endpoint: ${payload.endpoint || "—"}`,
      `- Тема панели: ${payload.panelTheme}`,
      `- Сообщений: ${payload.messages.length}`,
      "",
      "---",
      "",
    ];
    for (const message of payload.messages) {
      const title =
        message.role === "user"
          ? "## Вы"
          : message.role === "assistant"
            ? "## Агент"
            : message.role === "reasoning"
              ? "## Размышления"
              : message.role === "tool"
                ? "## Результат инструмента"
                : "## Система";
      lines.push(title, "", message.content || "_пусто_", "");
      lines.push("---", "");
    }
    if (payload.toolCalls.length) {
      lines.push("# Инструменты", "");
      for (const toolCall of payload.toolCalls) {
        lines.push(`## ${toolCall.name} — ${toolCall.status}`, "");
        if (toolCall.output) {
          lines.push("```text", toolCall.output, "```", "");
        }
        if (toolCall.errorMessage) {
          lines.push(`Ошибка: ${toolCall.errorMessage}`, "");
        }
        lines.push("---", "");
      }
    }
    return lines.join("\n");
  }

  /**
   * Делегирование кликов в ленте: кнопка у блока кода копирует код, обёрнутый в
   * тройные кавычки; клик по карточке ответа — копирует весь ответ.
   */
  onMessagesClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const codeCopy = target.closest(".code-copy") as HTMLElement | null;
    if (codeCopy) {
      const figure = codeCopy.closest(".codeblock");
      const code = figure?.querySelector("code");
      if (code) {
        event.preventDefault();
        event.stopPropagation();
        void this.copyToClipboard(
          wrapCodeForClipboard(code.textContent ?? ""),
        ).then((ok) => this.flashCopyButton(codeCopy, ok));
      }
      return;
    }

    const messageEl = target.closest(".message.assistant") as HTMLElement | null;
    if (
      messageEl &&
      !target.closest(
        "a, button, input, textarea, .codeblock, .tool-call-card, .ask-user-card",
      ) &&
      !(window.getSelection()?.toString() ?? "")
    ) {
      const id = messageEl.getAttribute("data-message-id");
      const message = id ? this.messages.find((item) => item.id === id) : undefined;
      if (message) {
        void this.copyAssistantMarkdown(message);
      }
    }
  }

  private flashCopyButton(button: HTMLElement, ok: boolean): void {
    const original = button.getAttribute("data-label") ?? button.textContent ?? "Копировать";
    button.setAttribute("data-label", original);
    button.textContent = ok ? "Скопировано" : "Ошибка";
    button.classList.toggle("copied", ok);
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1200);
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
          startedAt: Date.now(),
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
      const text = this.historyContentToText(message.content);
      const rawIds = (message.tool_calls ?? []).map((toolCall) => toolCall.id);
      const ids = rawIds.map((id) => this.canonicalToolCallId(id));
      if (ids.length) {
        if (text.trim()) {
          // Есть текст и вызовы: показываем текст, а карточки вешаем на него —
          // это сообщение становится «хостом» шага.
          this.finalizeStreamingMessage("assistant", text, { toolCallIds: ids });
          this.toolHostMessageId = this.lastAssistantMessageId();
        } else {
          // Только вызовы: без нового пустого блока «Ассистент» — складываем
          // карточки в хост текущего хода.
          this.appendToolCallsToHost(ids);
        }
        return;
      }
      this.finalizeStreamingMessage("assistant", text);
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
      const toolCallId = message.tool_call_id
        ? this.canonicalToolCallId(message.tool_call_id)
        : null;
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
      const finishedAt = Date.now();
      this.messages = this.messages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        const durationMs =
          message.startedAt != null && message.durationMs == null
            ? finishedAt - message.startedAt
            : message.durationMs;
        return { ...message, content, streaming: false, durationMs, ...extra };
      });
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
      this.toolCalls = [...this.toolCalls, this.withToolTiming(toolCall)];
    } else {
      const next = [...this.toolCalls];
      next[existingIndex] = this.withToolTiming({
        ...next[existingIndex],
        ...toolCall,
      });
      this.toolCalls = next;
    }

    // Спиннер и таймер живут ровно пока выполняется команда.
    this.syncShellTimer();
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

  /** Веб-инструменты отдают Markdown — в панели его рендерим, а не показываем `<pre>`. */
  isRichToolOutput(toolCall: ToolCallViewModel): boolean {
    return (
      toolCall.name === "web_search" ||
      toolCall.name === "web_fetch" ||
      toolCall.name === "deep_search"
    );
  }

  private getToolExecutionState(output: string): ToolExecutionState | null {
    if (output.startsWith(TOOL_PROGRESS_PREFIX)) {
      return {
        status: "executing",
        output,
      };
    }

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

  /** Команда реально выполняется (или ждёт ввода) прямо сейчас. */
  get isShellRunning(): boolean {
    return this.toolCalls.some(
      (toolCall) =>
        toolCall.name === "run_shell_command" &&
        (toolCall.status === "executing" ||
          toolCall.status === "awaiting_terminal_input"),
    );
  }

  /** Спиннер и таймер — только на время выполнения команды, а не «работы» вообще. */
  get showRunStatus(): boolean {
    return this.isShellRunning;
  }

  get runStatusLabel(): string {
    return this.toolCalls.some(
      (toolCall) =>
        toolCall.name === "run_shell_command" &&
        toolCall.status === "awaiting_terminal_input",
    )
      ? "Ожидание ввода в терминале…"
      : "Выполняется команда…";
  }

  /**
   * Запускает таймер выполнения команды (идемпотентно). Тикает каждые 100 мс,
   * чтобы отсчёт начинался с миллисекунд и плавно переходил в секунды: 0.85 с →
   * 6.59 с → 12.3 с → 1 мин 5 с.
   */
  private startExecutionTimer(): void {
    if (this.executionTimer) {
      return;
    }
    this.turnStartedAt = Date.now();
    this.commandElapsedMs = 0;
    this.executionTimer = setInterval(() => {
      this.commandElapsedMs = Date.now() - this.turnStartedAt;
    }, 100);
  }

  private stopExecutionTimer(): void {
    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = null;
    }
    this.commandElapsedMs = 0;
  }

  /** Таймер идёт ровно пока выполняется команда. */
  private syncShellTimer(): void {
    if (this.isShellRunning) {
      this.startExecutionTimer();
    } else {
      this.stopExecutionTimer();
    }
  }

  /** Живой отсчёт таймера для строки статуса. */
  get commandElapsedDisplay(): string {
    return this.formatDuration(this.commandElapsedMs);
  }

  /**
   * Человекочитаемая длительность: 850 мс → 6.59 с → 12.3 с → 1 мин 5 с.
   * До 1 с — миллисекунды, до 10 с — сотые, до минуты — десятые.
   */
  formatDuration(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) {
      return "";
    }
    if (ms < 1000) {
      return `${Math.round(ms)} мс`;
    }
    const seconds = ms / 1000;
    if (seconds < 10) {
      return `${seconds.toFixed(2)} с`;
    }
    if (seconds < 60) {
      return `${seconds.toFixed(1)} с`;
    }
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    const restText = rest < 10 ? rest.toFixed(1) : Math.round(rest).toString();
    return `${minutes} мин ${restText} с`;
  }

  /** Проставляет startedAt/durationMs карточке по её статусу. */
  private withToolTiming(toolCall: ToolCallViewModel): ToolCallViewModel {
    const terminal =
      toolCall.status === "completed" ||
      toolCall.status === "error" ||
      toolCall.status === "blocked";
    let startedAt = toolCall.startedAt ?? null;
    let durationMs = toolCall.durationMs ?? null;
    if (toolCall.status === "executing" && startedAt == null) {
      startedAt = Date.now();
    }
    if (terminal && startedAt != null && durationMs == null) {
      durationMs = Date.now() - startedAt;
    }
    return { ...toolCall, startedAt, durationMs };
  }

  /** Канонический id карточки: повторные опросы указывают на первую. */
  private canonicalToolCallId(id: string | null | undefined): string {
    if (!id) {
      return "";
    }
    return this.toolCallAlias.get(id) ?? id;
  }

  private resetTurnGrouping(): void {
    this.toolHostMessageId = null;
    this.pollCardId = null;
    this.toolCallAlias.clear();
  }

  private lastAssistantMessageId(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].role === "assistant") {
        return this.messages[i].id;
      }
    }
    return null;
  }

  /**
   * Складывает карточки инструментов в одно сообщение-хост текущего хода, чтобы
   * длинный цикл шагов не плодил пустые блоки «Ассистент» на каждый вызов.
   */
  private appendToolCallsToHost(ids: string[]): void {
    if (!ids.length) {
      return;
    }
    const host = this.toolHostMessageId
      ? this.messages.find((message) => message.id === this.toolHostMessageId)
      : undefined;
    if (host) {
      this.messages = this.messages.map((message) =>
        message.id === host.id
          ? {
              ...message,
              toolCallIds: Array.from(
                new Set([...(message.toolCallIds ?? []), ...ids]),
              ),
            }
          : message,
      );
    } else {
      const id = this.generateId("assistant");
      this.messages = [
        ...this.messages,
        {
          id,
          role: "assistant",
          content: "",
          streaming: false,
          toolCallIds: ids,
          toolOnly: true,
        },
      ];
      this.toolHostMessageId = id;
    }
    this.scheduleScrollToBottom();
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
    // Панель обязана показать вопрос, даже если её представление вызова разошлось
    // с аргументами инструмента. Раньше сравнение сырой строки вопроса падало при
    // любом расхождении (пробелы/переводы строк вокруг вопроса, нормализация в
    // инструменте) и модель получала "Unable to present ask_user prompt in the panel."
    // вместо окна вопроса — после чего переставала спрашивать вообще.
    const normalizedArgs: { question: string; choices?: string[] } = {
      ...args,
      question: typeof args.question === "string" ? args.question.trim() : args.question,
    };
    this.upsertToolCall(
      this.toToolCallViewModel(toolCallId, "ask_user", normalizedArgs, {
        status: "awaiting_user_input",
        output: "Ожидание ввода пользователя в панели агента.",
        errorMessage: null,
      }),
    );

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
      const result = await this.chatSession.compactHistory({
        contextWindowTokens: this.contextWindowTokens,
        signal: this.currentAbortController?.signal,
      });
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


/** Markdown → обычный текст (для кнопки «Текст»). */
function stripMarkdown(input: string): string {
  return String(input ?? "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^\s*\|(.*)\|\s*$/gm, (_m, row: string) =>
      row.split("|").map((cell) => cell.trim()).filter(Boolean).join("  "),
    )
    .replace(/^\s*[-:| ]{3,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
