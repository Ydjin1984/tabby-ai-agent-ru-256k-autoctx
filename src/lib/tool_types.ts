export interface ToolArgDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
}

export interface ToolDefinition<TArgs = any> {
  name: string;
  arguments: ToolArgDefinition[];
  description: string;
  exec: (args: TArgs, context?: ToolExecutionContext) => Promise<string>;
}

export interface ToolExecutionState {
  status: "executing" | "awaiting_terminal_input" | "awaiting_user_input";
  output?: string | null;
}

/**
 * Маркер промежуточного прогресса в выводе инструмента. Панель по этому префиксу
 * понимает, что вызов ещё выполняется, и не помечает его завершённым раньше времени.
 */
export const TOOL_PROGRESS_PREFIX = "ПРОГРЕСС:";

export function toolProgress(message: string): string {
  return `${TOOL_PROGRESS_PREFIX} ${String(message ?? "").trim()}`;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  toolCallId?: string;
  onStateChange?: (state: ToolExecutionState) => void;
}

export interface Tool {
  name(): string;
  description(): string;
  arguments(): ToolArgDefinition[];
  exec(args: any, context?: ToolExecutionContext): Promise<string>;
  execSimulated?(args: any): Promise<string>;
}
