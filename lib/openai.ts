import type { ChatMessage, Session, ToolCall, Turn } from "./types";

/** OpenAI-shaped helpers for the compatibility surface. */

export function newCompletionId() {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

export function errorBody(
  status: number,
  message: string,
  code: string,
  type = "invalid_request_error",
) {
  return Response.json(
    { error: { message, type, code, param: null } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function completionBody(
  turn: Turn,
  session: Session,
  created: number,
  modelOverride?: string,
) {
  const reply = turn.reply ?? { content: "", toolCalls: [] };
  const message: ChatMessage = {
    role: "assistant",
    content: reply.toolCalls.length && !reply.content ? null : reply.content,
  };
  if (reply.toolCalls.length) message.tool_calls = reply.toolCalls;

  return {
    id: newCompletionId(),
    object: "chat.completion",
    created,
    model: modelOverride || session.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: turn.finishReason ?? (reply.toolCalls.length ? "tool_calls" : "stop"),
        logprobs: null,
      },
    ],
    usage: usageFor(session.messages, reply),
    system_fingerprint: "changeling_human_in_the_loop",
  };
}

export function usageFor(
  messages: ChatMessage[],
  reply: { content: string; toolCalls: ToolCall[] },
) {
  const prompt = messages.reduce((n, m) => n + roughTokens(textOf(m)), 0);
  const completion =
    roughTokens(reply.content) +
    reply.toolCalls.reduce((n, c) => n + roughTokens(c.function.name + c.function.arguments) + 4, 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function textOf(m: ChatMessage): string {
  const parts: string[] = [];
  if (typeof m.content === "string") parts.push(m.content);
  else if (Array.isArray(m.content)) parts.push(JSON.stringify(m.content));
  if (m.tool_calls) parts.push(JSON.stringify(m.tool_calls));
  return parts.join(" ");
}

/** Crude but stable: ~4 chars per token. Only used for display. */
export function roughTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function sse(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const DONE = new TextEncoder().encode("data: [DONE]\n\n");
const PING = new TextEncoder().encode(": changeling-heartbeat\n\n");

export const sseDone = () => DONE;
export const ssePing = () => PING;

export interface StreamInit {
  id: string;
  model: string;
  created: number;
}

function chunk(
  init: StreamInit,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  return {
    id: init.id,
    object: "chat.completion.chunk",
    created: init.created,
    model: init.model,
    system_fingerprint: "changeling_human_in_the_loop",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

/**
 * Changeling answers in a single burst, but OpenAI clients expect a shaped
 * stream: role first, then content, then tool_calls, then the terminator.
 */
export function* streamFrames(
  init: StreamInit,
  turn: Turn,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null,
): Generator<unknown, void, void> {
  const reply = turn.reply ?? { content: "", toolCalls: [] };
  yield chunk(init, { role: "assistant", content: "" });

  if (reply.content) {
    for (const piece of splitForStream(reply.content)) {
      yield chunk(init, { content: piece });
    }
  }

  for (const [index, call] of reply.toolCalls.entries()) {
    yield chunk(init, {
      tool_calls: [
        {
          index,
          id: call.id,
          type: "function",
          function: { name: call.function.name, arguments: "" },
        },
      ],
    });
    for (const piece of splitForStream(call.function.arguments, 48)) {
      yield chunk(init, {
        tool_calls: [{ index, function: { arguments: piece } }],
      });
    }
  }

  yield chunk(init, {}, turn.finishReason ?? (reply.toolCalls.length ? "tool_calls" : "stop"));

  if (usage) {
    yield {
      id: init.id,
      object: "chat.completion.chunk",
      created: init.created,
      model: init.model,
      choices: [],
      usage,
    };
  }
}

function splitForStream(text: string, size = 24): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Wait for a promise while keeping the HTTP response warm. */
export async function awaitWithHeartbeat<T>(
  promise: Promise<T>,
  enqueue: (bytes: Uint8Array) => void,
  intervalMs = 12_000,
): Promise<T> {
  const timer = setInterval(() => {
    try {
      enqueue(PING);
    } catch {
      /* stream already closed */
    }
  }, intervalMs);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

export function agentLabel(req: Request): string {
  const ua = req.headers.get("user-agent") || "";
  const explicit = req.headers.get("x-agent-name");
  if (explicit) return explicit.slice(0, 40);
  const known: Array<[RegExp, string]> = [
    [/opencode/i, "OpenCode"],
    [/claude[-_ ]?code/i, "Claude Code"],
    [/pi[-_ ]?(agent|cli)/i, "Pi"],
    [/cursor/i, "Cursor"],
    [/cline/i, "Cline"],
    [/continue/i, "Continue"],
    [/aider/i, "Aider"],
    [/node|undici|axios|fetch|python|curl/i, "HTTP client"],
  ];
  for (const [re, label] of known) if (re.test(ua)) return label;
  return ua ? ua.split("/")[0].slice(0, 40) : "Unknown agent";
}
