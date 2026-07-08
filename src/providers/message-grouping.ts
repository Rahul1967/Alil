import type { ChatMessage } from "./types.ts";

/**
 * The loop represents each tool result as its own `tool` message. Both the Anthropic
 * Messages API and the Bedrock Converse API, however, require that every tool result
 * answering the preceding assistant turn's tool_use blocks live in a SINGLE user message.
 * Emitting one user message per result makes the provider see only the first result at the
 * expected position and reject the turn (e.g. Bedrock: "Expected toolResult blocks ...").
 *
 * `groupMessages` collapses each run of consecutive `tool` messages into one group so
 * providers can render it as a single user message carrying all of its result blocks.
 */
export type ToolResultRef = { toolCallId: string; content: string };

export type MessageGroup =
  | { kind: "message"; message: ChatMessage }
  | { kind: "toolResults"; results: ToolResultRef[] };

export function groupMessages(messages: ChatMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const last = out[out.length - 1];
      const ref: ToolResultRef = { toolCallId: m.toolCallId ?? "", content: m.content ?? "" };
      if (last && last.kind === "toolResults") {
        last.results.push(ref);
      } else {
        out.push({ kind: "toolResults", results: [ref] });
      }
    } else {
      out.push({ kind: "message", message: m });
    }
  }
  return out;
}
