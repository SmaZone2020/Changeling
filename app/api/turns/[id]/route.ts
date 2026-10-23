import type { FinishReason } from "@/lib/types";
import { answer, cancelTurn, ChangelingError } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: string }>;
  finishReason?: FinishReason;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const content = typeof body.content === "string" ? body.content : "";
  const toolCalls = Array.isArray(body.toolCalls) ? body.toolCalls : [];
  if (!content.trim() && toolCalls.length === 0 && body.finishReason !== "stop") {
    return Response.json(
      { error: "Write a reply, add a tool call, or explicitly end the turn." },
      { status: 400 },
    );
  }
  for (const call of toolCalls) {
    if (!call || typeof call.name !== "string" || !call.name.trim()) {
      return Response.json({ error: "Every tool call needs a name." }, { status: 400 });
    }
    if (typeof call.arguments !== "string") {
      return Response.json({ error: "Tool arguments must be a JSON string." }, { status: 400 });
    }
  }

  try {
    const turn = answer(id, { content, toolCalls, finishReason: body.finishReason });
    return Response.json({ ok: true, turn });
  } catch (err) {
    if (err instanceof ChangelingError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return Response.json({ error: "Failed to submit reply" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const turn = cancelTurn(id);
    return Response.json({ ok: true, turn });
  } catch (err) {
    if (err instanceof ChangelingError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return Response.json({ error: "Failed to cancel" }, { status: 500 });
  }
}
