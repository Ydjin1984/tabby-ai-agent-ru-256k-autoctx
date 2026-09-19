import { Tool } from "./tool_types";
import { MemoryBridge } from "../memory/types";
import defaultSystemPromptTemplate from "../prompts/default_system_prompt.md";
import {
  buildChatCompletionsUrl,
  buildCheckpointRequestBody,
  normalizeOpenAIBaseUrl,
} from "./llm_endpoint";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateHistoryTokens,
  estimateToolSchemaTokens,
  takeTailByTokens,
} from "./context_usage";
import { injectMemoryIntoMessages } from "./request_messages";
import { stripReasoningParameters, looksRepetitive } from "./request_defaults";

export interface LLMHistoryItem {
  role: "system" | "user" | "assistant" | "tool" | "reasoning";
  content: string | null | any[];
  tool_call_id?: string | null;
  tool_calls?: ToolCallAccumulator[] | null;
}

type ToolCallAccumulator = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export function buildSystemPrompt(additionalPrompt?: string): string {
  const parts = [defaultSystemPromptTemplate.trim()];
  const extra = additionalPrompt?.trim();
  if (extra) {
    parts.push(extra);
  }
  return parts.join("\n\n");
}

const SYSTEM_SUMMARY_PROMPT = `You are a conversation compressor for an AI terminal agent.
Your job is to produce a dense, lossy-but-useful summary of the provided conversation history.
Preserve: the user's goals and current tasks; the current state of any in-progress work;
every command that was executed and its outcome; important facts, paths, file names, ports,
addresses, error messages and their resolutions; the last known state before interruption.
Do NOT preserve: the full verbatim output of tools, repeated boilerplate, or reasoning chain text.
Write the summary in the same language the conversation is mostly written in (English or Russian).
Be concrete and structured. Output only the summary, no preamble.`;

function buildRequestHeaders(apiToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const trimmedToken = apiToken?.trim();
  if (trimmedToken) {
    headers.Authorization = `Bearer ${trimmedToken}`;
  }
  return headers;
}

export async function checkpointLLMEndpoint(
  baseUrl: string,
  apiToken?: string,
  model = "default",
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(buildChatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: buildRequestHeaders(apiToken),
      signal: controller.signal,
      body: JSON.stringify(buildCheckpointRequestBody(model)),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Checkpoint API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
      );
    }

    await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export class LLMChatSession {
  private history: LLMHistoryItem[] = [];
  private warmupPromise: Promise<void> | null = null;
  private baseUrl: string;
  private apiToken: string;
  private model: string;
  private extraParameters: Record<string, any> = {};
  /**
   * Set after the model produced reasoning but no answer on the token limit:
   * the retry runs without reasoning switches so the user gets an answer
   * instead of an endless "thinking" stream.
   */
  private disableReasoning = false;
  toolCalls: { name: string; args: any; output: string }[] = [];
  tools: Tool[];
  toolSchema: any[];
  /** Optional persistent-memory bridge injected by the panel. */
  private memory?: MemoryBridge;

  /**
   * Exact prompt-token count reported by the server for the last request
   * (OpenAI-compatible servers that send `usage` in streaming responses).
   */
  lastReportedPromptTokens: number | null = null;

  constructor(
    baseUrl: string,
    systemPrompt: string,
    tools: Tool[],
    apiToken?: string,
    model = "default",
    extraParameters?: Record<string, any>,
    history?: LLMHistoryItem[],
    memory?: MemoryBridge,
  ) {
    this.baseUrl = normalizeOpenAIBaseUrl(baseUrl);
    this.apiToken = apiToken?.trim() ?? "";
    this.model = model.trim() || "default";
    this.extraParameters = extraParameters || {};
    this.memory = memory;
    this.tools = tools;
    this.toolSchema = buildToolSchema(this.tools || []);

    if (systemPrompt) {
      this.history.push({
        role: "system",
        content: systemPrompt,
      });
    }
    if (history) {
      this.history.push(...history);
    }
  }

  /**
   * Copy of the dialogue history. The panel rebuilds the session when the
   * model, endpoint, token, or reasoning level changes, and passes this back
   * in so the conversation survives the switch.
   */
  snapshotHistory(): LLMHistoryItem[] {
    return [...this.history];
  }

  async chat(options: {
    userMessage: string;
    image?: string | null;
    images?: string[] | null;
    silent?: boolean;
    onToken?: (token: string) => Promise<void>;
    onReasoningToken?: (token: string) => Promise<void>;
    onToolCall?: (
      toolCallId: string,
      toolName: string,
      args: any,
    ) => Promise<boolean>;
    onToolResult?: (
      toolCallId: string,
      toolName: string,
      args: any,
      output: string,
    ) => Promise<void>;
    onStopReason?: (
      reason: "tool_calls" | "stop",
      timings: LlamaCppTimings,
    ) => Promise<void>;
    onPushHistory?: (message: LLMHistoryItem, index: number) => Promise<void>;
    onToolError?: (
      toolCallId: string,
      fullText: string,
      toolName: string,
      args: any,
      errorMessage: string,
      stackTrace: string,
    ) => Promise<void>;
    simulatedMode?: boolean;
    signal?: AbortSignal;
    /** Service note for the panel (retry after an empty "thinking" answer, etc.). */
    onNotice?: (message: string) => Promise<void> | void;
    /** Throw away the partially streamed draft before a retry. */
    onDiscardDraft?: () => Promise<void> | void;
  }) {
    const pushHistory = async (message: LLMHistoryItem) => {
      this.history.push(message);
      if (options.onPushHistory && !options.simulatedMode) {
        await options.onPushHistory(message, this.history.length - 1);
      }
    };

    if (!options.silent) {
      console.log(options.userMessage);
      if (options.image) {
        console.log(
          `With image: ${options.image.length} characters of data URL`,
        );
      }
    }

    const imageList = options.images?.length
      ? options.images
      : options.image
        ? [options.image]
        : [];
    if (imageList.length) {
      const content: any[] = [];
      if (options.userMessage) {
        content.push({ type: "text", text: options.userMessage });
      }
      for (const img of imageList) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
      await pushHistory({ role: "user", content });
    } else {
      await pushHistory({ role: "user", content: options.userMessage });
    }

    await this.observeMemory(() =>
      this.memory!.observeUserMessage(options.userMessage),
    );
    const memoryContext = await this.buildMemoryContext(options.userMessage);

    while (true) {
      this.throwIfAborted(options.signal);
      const response = await fetch(buildChatCompletionsUrl(this.baseUrl), {
        method: "POST",
        headers: buildRequestHeaders(this.apiToken),
        signal: options.signal,
        body: JSON.stringify({
          model: this.model,
          messages: this.buildRequestMessages(memoryContext),
          stream: true,
          tools: this.toolSchema,
          ...(this.disableReasoning
            ? stripReasoningParameters(this.extraParameters)
            : this.extraParameters),
        }),
      });
      if (!response.ok) {
        console.log(this.history);
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let fullReasoning = "";
      const requestedToolCalls: Record<number, ToolCallAccumulator> = {};
      let finishReason: "tool_calls" | "stop" | null = null;
      let lastStdoutWasReasoning = false;
      while (true) {
        this.throwIfAborted(options.signal);
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
        for (const line of lines) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const usage = parsed.usage;
            if (
              usage &&
              typeof usage.prompt_tokens === "number" &&
              Number.isFinite(usage.prompt_tokens)
            ) {
              this.lastReportedPromptTokens = usage.prompt_tokens;
            }
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) {
              const timing: LlamaCppTimings = parsed.timings;
              finishReason = choice.finish_reason;
              if (options.onStopReason) {
                await options.onStopReason(choice.finish_reason, timing);
              }
              break;
            }
            const delta = choice.delta;
            if (!delta) continue;
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const i = tc.index;
                if (!requestedToolCalls[i]) {
                  requestedToolCalls[i] = {
                    id: tc.id,
                    type: "function",
                    function: { name: tc.function?.name ?? "", arguments: "" },
                  };
                }
                if (tc.function?.arguments) {
                  requestedToolCalls[i].function.arguments +=
                    tc.function.arguments;
                }
              }
            }
            if (delta.reasoning) {
              throw new Error("different format");
            }
            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              if (!options.silent) {
                process.stdout.write(delta.reasoning_content);
                lastStdoutWasReasoning = true;
              }
              if (options.onReasoningToken) {
                await options.onReasoningToken(delta.reasoning_content);
              }
            } else if (delta.content) {
              fullContent += delta.content;
              if (!options.silent) {
                if (lastStdoutWasReasoning) {
                  process.stdout.write("\n");
                  lastStdoutWasReasoning = false;
                }
                process.stdout.write(delta.content);
              }
              if (options.onToken) await options.onToken(delta.content);
            }
          } catch {
            console.warn("Failed to parse chunk:", data);
            // skip malformed chunks
          }
        }
      }

      if (fullReasoning)
        await pushHistory({ role: "reasoning", content: fullReasoning });

      if (finishReason === "tool_calls") {
        // Snapshot history length before pushing the assistant tool_calls message.
        // If we are aborted mid-tool-execution, we must roll back to keep the
        // conversation valid – an assistant message with tool_calls MUST be
        // followed by exactly one tool message per tool_call.
        const historyBeforeToolCalls = this.history.length;
        await pushHistory({
          role: "assistant",
          content: fullContent.trim() ? fullContent : null,
          tool_calls: Object.values(requestedToolCalls),
        });
        try {
          for (const tc of Object.values(requestedToolCalls)) {
          if (!this.tools) continue;
          const name = tc.function.name || "unknown";
          const args = JSON.parse(tc.function.arguments);
          const toolCallId = tc.id || crypto.randomUUID();
          const tool = this.tools.find((t) => t.name() === name);
          if (!tool) throw new Error(`Unknown tool requested: ${name}`);
          const toolName = tool.name();
          let toolOutput: string;
          let allow = true;
          let stopAfterToolResult = false;
          let toolErrorMessage: string | undefined;
          if (!options.silent)
            console.log(`Tool call: ${toolName} with args`, args);
          if (options.onToolCall) {
            allow = await options.onToolCall(toolCallId, toolName, args);
          }
          if (!allow) {
            toolOutput = `Tool ${toolName} call was not allowed because the user declined it. Current response stopped.`;
            stopAfterToolResult = true;
          } else {
            try {
              this.throwIfAborted(options.signal);
              if (options.simulatedMode && tool.execSimulated) {
                toolOutput = await tool.execSimulated(args);
              } else if (options.simulatedMode) {
                toolOutput = `Tool ${toolName} executed successfully.`;
              } else {
                toolOutput = await tool.exec(args, {
                  signal: options.signal,
                  toolCallId,
                  onStateChange: options.onToolResult
                    ? (state) =>
                        options.onToolResult!(
                          toolCallId,
                          toolName,
                          args,
                          state.output ?? "",
                        )
                    : undefined,
                });
              }
              this.toolCalls.push({ name: toolName, args, output: toolOutput });
            } catch (error) {
              if (this.isAbortError(error)) {
                throw error;
              }

              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const stackTrace =
                error instanceof Error && error.stack
                  ? error.stack
                  : "Стек-трейс недоступен";

              let fullDetails = ``;
              fullDetails += `Ошибка выполнения инструмента ${toolName}:\n`;
              fullDetails += `Аргументы: ${JSON.stringify(args)}\n`;
              fullDetails += `Сообщение: ${errorMessage}\n`;
              fullDetails += `Стек-трейс:\n${stackTrace}\n`;

              if (options.onToolError)
                await options.onToolError(
                  toolCallId,
                  fullDetails,
                  toolName,
                  args,
                  errorMessage,
                  stackTrace,
                );

              console.error(fullDetails);
              toolOutput = `Ошибка выполнения инструмента ${toolName}: ${errorMessage}`;
              toolErrorMessage = errorMessage;
            }
          }
          await this.observeMemory(() =>
            this.memory!.observeToolResult({
              toolName,
              args,
              output: toolOutput,
              ok: allow && !toolErrorMessage,
              errorMessage: toolErrorMessage,
            }),
          );
          if (!options.silent) {
            console.log(`Tool result for ${toolName}`);
            console.log(toolOutput);
          }
          if (options.onToolResult) {
            await options.onToolResult(toolCallId, toolName, args, toolOutput);
          }
          console.log("Tool output:", toolOutput);
          await pushHistory({
            role: "tool",
            content: toolOutput,
            tool_call_id: toolCallId,
          });
          if (stopAfterToolResult) {
            await this.observeMemory(() => this.memory!.finishTurn());
            return fullContent;
          }
        }
        } catch (error) {
          // If the user aborted during tool execution, roll back history to
          // remove the orphaned assistant tool_calls message (and any partial
          // tool messages), keeping the conversation valid for the next request.
          if (this.isAbortError(error)) {
            this.history.splice(historyBeforeToolCalls);
          }
          throw error;
        }
        continue;
      } else if (finishReason === "stop") {
        // Normal completion
        await pushHistory({ role: "assistant", content: fullContent.trim() });
        await this.observeMemory(() =>
          this.memory!.observeAssistantMessage(fullContent),
        );
        await this.observeMemory(() => this.memory!.finishTurn());
        if (!options.silent) process.stdout.write("\n");
        return fullContent;
      } else if (finishReason === "length") {
        // Generation stopped by the token limit.
        const truncated = fullContent.trim();
        const looped = looksRepetitive(truncated);
        // A usable (merely long) answer is returned; a looping one is garbage and
        // is retried with reasoning switches removed.
        if (truncated && !looped) {
          await pushHistory({ role: "assistant", content: truncated });
          await this.observeMemory(() =>
            this.memory!.observeAssistantMessage(fullContent),
          );
          await this.observeMemory(() => this.memory!.finishTurn());
          if (!options.silent) process.stdout.write("\n");
          await options.onNotice?.(
            "Ответ обрезан по лимиту генерации (max_tokens). Увеличьте max_tokens в дополнительных параметрах, если нужен полный ответ.",
          );
          return fullContent;
        }
        // Nothing usable was produced. On the local brain this is what happens
        // when the model spends the whole budget on reasoning (and, with a long
        // task, loops): retry once without reasoning switches instead of
        // throwing or handing the user a wall of repeated text.
        if ((fullReasoning.trim() || truncated) && !this.disableReasoning) {
          this.disableReasoning = true;
          await options.onDiscardDraft?.();
          if (!options.silent) process.stdout.write("\n");
          await options.onNotice?.(
            looped
              ? "Ответ ушёл в повтор — повторяю запрос с выключенными размышлениями."
              : "Модель ушла в размышления и не дала ответа — повторяю запрос с выключенными размышлениями.",
          );
          continue;
        }
        throw new Error(
          "Модель не дала ответа: генерация остановлена по лимиту токенов. " +
            "Проверьте max_tokens и thinking_budget_tokens в дополнительных параметрах плагина.",
        );
      } else {
        throw new Error("Неизвестная причина завершения: " + finishReason);
      }
    }
  }

  async warmup(): Promise<void> {
    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    this.warmupPromise = (async () => {
      const warmupMessages: LLMHistoryItem[] = [
        ...this.history,
        {
          role: "user",
          content: "Прогрей кэш сессии для следующего реального сообщения пользователя.",
        },
      ];

      const response = await fetch(buildChatCompletionsUrl(this.baseUrl), {
        method: "POST",
        headers: buildRequestHeaders(this.apiToken),
        body: JSON.stringify({
          model: this.model,
          messages: warmupMessages,
          stream: false,
          n_predict: 0,
          cache_prompt: true,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Warmup API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
        );
      }
      await response.text();
    })();

    try {
      await this.warmupPromise;
    } catch (error) {
      this.warmupPromise = null;
      throw error;
    }
  }
  getHistory(): LLMHistoryItem[] {
    return structuredClone(this.history);
  }

  /**
   * Estimated (or server-reported) number of tokens currently occupying the
   * context window: system prompt + all messages + tool schema.
   */
  getEstimatedContextTokens(): number {
    return (
      estimateHistoryTokens(this.history) +
      estimateToolSchemaTokens(this.toolSchema)
    );
  }

  /**
   * Tokens for display: prefer the server-reported value when available, but
   * never below our own estimate — some servers report `usage` only once or
   * with a stale value, which would freeze the meter.
   */
  getContextTokensForDisplay(): { tokens: number; exact: boolean } {
    const estimate = this.getEstimatedContextTokens();
    if (this.lastReportedPromptTokens !== null) {
      return {
        tokens: Math.max(this.lastReportedPromptTokens, estimate),
        exact: true,
      };
    }
    return { tokens: estimate, exact: false };
  }

  /**
   * Compress the conversation history into a short summary and replace the
   * history with the original system prompt + the summary. The agent can then
   * keep working with a much smaller context window.
   */
  async compactHistory(options?: {
    maxSummaryTokens?: number;
    signal?: AbortSignal;
  }): Promise<{
    summary: string;
    beforeTokens: number;
    afterTokens: number;
  }> {
    const maxSummaryTokens = options?.maxSummaryTokens ?? 4000;
    const fullHistory = this.history.filter((h) => h.role !== "reasoning");

    const systemPrompt = fullHistory
      .filter((h) => h.role === "system")
      .map((h) =>
        typeof h.content === "string"
          ? h.content
          : JSON.stringify(h.content),
      )
      .join("\n\n");
    const rest = fullHistory.filter((h) => h.role !== "system");

    const beforeTokens = this.getEstimatedContextTokens();
    const windowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;

    // The compaction request must comfortably fit the context window together
    // with the summarizer prompt and the completion. Our heuristic token
    // estimate can be significantly below the real token count (llama.cpp
    // counted 263k tokens where the heuristic said < 223k), and JSON escaping
    // inflates the dump further — so use a conservative budget with a large
    // safety factor, and prefer the server-reported prompt-token count when
    // we have one (it is the exact size of the last real request).
    const SAFETY_FACTOR = 2;
    const maxDumpTokens = Math.floor(windowTokens * 0.5);
    const maxDumpByEstimate = Math.floor(maxDumpTokens / SAFETY_FACTOR);

    let toSummarize = rest;
    const estimatedDumpTokens = estimateHistoryTokens(rest);
    const upperBoundDumpTokens = Math.max(
      estimatedDumpTokens * SAFETY_FACTOR,
      this.lastReportedPromptTokens ?? 0,
    );
    if (upperBoundDumpTokens > maxDumpTokens) {
      toSummarize = takeTailByTokens(rest, maxDumpByEstimate);
    }

    // Compact JSON: no pretty-printing (indentation doubles dump size).
    let dump = JSON.stringify(toSummarize) ?? "[]";
    // Last resort: trim the dump text itself if even the tail is oversized
    // (e.g. one single enormous tool output). ~2.5 chars per token is a
    // conservative ratio for mixed text/code.
    const maxDumpChars = Math.floor(maxDumpTokens * 2.5);
    if (dump.length > maxDumpChars) {
      dump = `${dump.slice(0, maxDumpChars)}\n... (truncated)`;
    }

    const summaryRequest: LLMHistoryItem[] = [
      { role: "system", content: SYSTEM_SUMMARY_PROMPT },
      { role: "user", content: `Conversation history:\n${dump}` },
    ];

    const response = await fetch(buildChatCompletionsUrl(this.baseUrl), {
      method: "POST",
      headers: buildRequestHeaders(this.apiToken),
      signal: options?.signal,
      body: JSON.stringify({
        model: this.model,
        messages: summaryRequest,
        stream: false,
        max_tokens: maxSummaryTokens,
        temperature: 0.2,
        ...this.extraParameters,
      }),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Compaction API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
      );
    }
    const data = await response.json();
    const summary = String(data?.choices?.[0]?.message?.content ?? "")
      .trim();
    if (!summary) {
      throw new Error("Сжатие вернуло пустое резюме.");
    }

    // Some chat templates (Qwen3-based models) reject a system message that is
    // not the first one, so the summary is folded into the existing system
    // prompt instead of being pushed as a second system message.
    const mergedSystem = [
      systemPrompt,
      `Summary of the earlier conversation (compacted). Keep these facts in mind:\n${summary}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    this.history = mergedSystem
      ? [{ role: "system", content: mergedSystem }]
      : [];
    this.lastReportedPromptTokens = null;

    return {
      summary,
      beforeTokens,
      afterTokens: this.getEstimatedContextTokens(),
    };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DOMException("Operation was aborted.", "AbortError");
    }
  }

  /**
   * Build the message array for a request. The transient memory block is
   * appended to the last user message rather than inserted as a system message:
   * strict chat templates reject a system message that is not at the beginning,
   * and keeping the system prompt untouched preserves prompt caching.
   */
  private buildRequestMessages(memoryContext: string | null): LLMHistoryItem[] {
    const messages = this.history.filter((item) => item.role !== "reasoning");
    return injectMemoryIntoMessages(messages, memoryContext);
  }

  private async buildMemoryContext(userMessage: string): Promise<string | null> {
    if (!this.memory?.enabled) {
      return null;
    }
    try {
      return await this.memory.buildContext(userMessage);
    } catch {
      return null;
    }
  }

  private async observeMemory(
    action: () => Promise<void> | void,
  ): Promise<void> {
    if (!this.memory?.enabled) {
      return;
    }
    try {
      await action();
    } catch {
      // Memory is best-effort and must never break a chat turn.
    }
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    );
  }
}

function buildToolSchema(tools: Tool[]) {
  return tools.map((tool) => {
    const args = tool.arguments();
    return {
      type: "function",
      function: {
        name: tool.name(),
        description: tool.description(),
        parameters: {
          type: "object",
          properties: args.reduce(
            (acc, arg) => {
              acc[arg.name] = {
                type: arg.type,
                description: `${arg.description}${arg.required ? " (required)" : ""}`,
                ...(arg.type === "array"
                  ? {
                      items: {
                        type: "string",
                      },
                    }
                  : {}),
              };
              return acc;
            },
            {} as Record<string, any>,
          ),
          required: tool
            .arguments()
            .filter((arg) => arg.required)
            .map((arg) => arg.name),
        },
      },
    };
  });
}

interface LlamaCppTimings {
  cache_n: number;
  prompt_n: number;
  prompt_ms: number;
  prompt_per_token_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_token_ms: number;
  predicted_per_second: number;
}
