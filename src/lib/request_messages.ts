/**
 * Request message assembly.
 *
 * Memory must NOT be injected as an extra `system` message in the middle of the
 * conversation: many chat templates (e.g. the Qwen3-based Kibborg brain) raise
 * "System message must be at the beginning" as soon as tools are present, which
 * turns the whole request into HTTP 500. Appending the memory block to the last
 * user message is template-safe and, unlike rewriting the system prompt, keeps
 * the stable prompt prefix intact for prompt caching.
 */

export interface ChatMessageLike {
  role: string;
  content: string | null | any[];
  tool_call_id?: string | null;
  tool_calls?: any[] | null;
}

export function injectMemoryIntoMessages<T extends ChatMessageLike>(
  messages: T[],
  memoryContext: string | null,
): T[] {
  if (!memoryContext || !messages.length) {
    return messages;
  }

  const result = messages.slice();
  let index = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      index = i;
      break;
    }
  }

  if (index === -1) {
    result.push({ role: "user", content: memoryContext } as T);
    return result;
  }

  const target = result[index];
  let content: string | any[];
  if (typeof target.content === "string") {
    content = `${target.content}\n\n${memoryContext}`;
  } else if (Array.isArray(target.content)) {
    content = [...target.content, { type: "text", text: memoryContext }];
  } else {
    content = memoryContext;
  }
  result[index] = { ...target, content } as T;
  return result;
}
