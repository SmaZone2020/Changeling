import type { ChatMessage, ToolDef } from "@/lib/types";
import { checkAuth, intake, RelayAbort, RelayTimeout, RelayError } from "@/lib/store";
import {
  agentLabel,
  awaitWithHeartbeat,
  completionBody,
  errorBody,
  newCompletionId,
  sse,
  sseDone,
  ssePing,
  streamFrames,
  usageFor,
} from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

interface Body {
  model?: string;
  messages?: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  parallel_tool_calls?: boolean;
  n?: number;
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const gate = checkAuth(auth);
  if (!gate.ok) {
    return errorBody(401, "Invalid API key for this relay.", "invalid_api_key", "authentication_error");
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return errorBody(400, "Request body must be valid JSON.", "invalid_json");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorBody(400, "`messages` must be a non-empty array.", "invalid_messages");
  }
  if (body.n && body.n > 1) {
    return errorBody(400, "Only n=1 is supported by the relay.", "unsupported_parameter");
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const model = body.model || "relay-human";
  const stream = body.stream === true;

  let result: ReturnType<typeof intake>;
  try {
    result = intake({
      apiKey: gate.hint,
      agent: agentLabel(req),
      model,
      messages: body.messages,
      tools,
      stream,
      temperature: body.temperature,
      topP: body.top_p,
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      toolChoice: body.tool_choice,
      parallelToolCalls: body.parallel_tool_calls,
      explicitSession: req.headers.get("x-relay-session"),
      signal: req.signal,
    });
  } catch (err) {
    if (err instanceof RelayError) return errorBody(err.status, err.message, err.code);
    return errorBody(500, "Relay failed to accept the request.", "relay_error");
  }

  const { session, turn, outcome } = result;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    const id = newCompletionId();
    const init = { id, model, created };
    const includeUsage = body.stream_options?.include_usage === true;

    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const push = (bytes: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(bytes);
          } catch {
            closed = true;
          }
        };

        // Tell the client immediately that the stream is live.
        push(ssePing());

        awaitWithHeartbeat(outcome, push)
          .then((resolved) => {
            const usage = includeUsage
              ? usageFor(session.messages, resolved.reply ?? { content: "", toolCalls: [] })
              : null;
            for (const frame of streamFrames(init, resolved, usage)) push(sse(frame));
            push(sseDone());
            closed = true;
            controller.close();
          })
          .catch((err: unknown) => {
            const message =
              err instanceof RelayTimeout
                ? "Operator did not respond before the deadline."
                : err instanceof RelayAbort
                  ? "Client disconnected."
                  : err instanceof Error
                    ? err.message
                    : "Relay failure.";
            push(sse({ error: { message, type: "relay_error", code: "relay_aborted" } }));
            push(sseDone());
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
      },
    });

    return new Response(bodyStream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-relay-session": session.id,
        "x-relay-turn": turn.id,
      },
    });
  }

  try {
    const resolved = await outcome;
    return Response.json(completionBody(resolved, session, created, model), {
      headers: {
        "cache-control": "no-store",
        "x-relay-session": session.id,
        "x-relay-turn": turn.id,
      },
    });
  } catch (err) {
    if (err instanceof RelayTimeout) {
      return errorBody(504, "Operator did not respond before the deadline.", "relay_timeout", "relay_error");
    }
    if (err instanceof RelayAbort) {
      return errorBody(499, "Client disconnected before a reply was submitted.", "relay_aborted", "relay_error");
    }
    return errorBody(500, err instanceof Error ? err.message : "Relay failure.", "relay_error", "relay_error");
  }
}

export async function GET() {
  return Response.json({
    object: "list",
    hint: "POST an OpenAI chat completion here. Human replies are supplied from /console.",
  });
}
