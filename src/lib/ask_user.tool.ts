import { Tool, ToolArgDefinition, ToolExecutionContext } from "./tool_types";

interface AskUserArgs {
  question: string;
  choices?: string[];
}

export class AskUserTool implements Tool {
  constructor(
    private requestAnswer: (
      toolCallId: string,
      args: AskUserArgs,
      signal?: AbortSignal,
    ) => Promise<string>,
  ) {}

  name(): string {
    return "ask_user";
  }

  description(): string {
    return [
      "Запросить у пользователя недостающую информацию в панели агента.",
      "Используйте свободный текст, если подходит любой ответ, или задайте варианты, если пользователь должен выбрать один.",
    ].join(" ");
  }

  arguments(): ToolArgDefinition[] {
    return [
      {
        name: "question",
        type: "string",
        description: "Точный вопрос, который нужно показать пользователю.",
        required: true,
      },
      {
        name: "choices",
        type: "array",
        description:
          "Необязательный список вариантов ответа. Опустите это поле, чтобы собрать свободный текст.",
        required: false,
      },
    ];
  }

  async exec(args: AskUserArgs, context?: ToolExecutionContext): Promise<string> {
    const question = args.question?.trim();
    if (!question) {
      throw new Error("ask_user requires a non-empty question.");
    }

    context?.onStateChange?.({
      status: "awaiting_user_input",
      output: "Ожидание ввода пользователя в панели агента.",
    });

    const toolCallId = context?.toolCallId;
    if (!toolCallId) {
      throw new Error("ask_user requires a tool call id.");
    }

    const answer = await this.requestAnswer(
      toolCallId,
      {
        question,
        choices: this.normalizeChoices(args.choices),
      },
      context?.signal,
    );

    return `Ответ пользователя: ${answer}`;
  }

  async execSimulated(args: AskUserArgs): Promise<string> {
    return `Имитация запроса ответа пользователя: ${args.question}`;
  }

  private normalizeChoices(choices?: string[]): string[] | undefined {
    if (!Array.isArray(choices)) {
      return undefined;
    }

    const normalized = choices
      .map((choice) => (typeof choice === "string" ? choice.trim() : ""))
      .filter((choice) => choice.length > 0);

    return normalized.length ? normalized : undefined;
  }
}
