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
