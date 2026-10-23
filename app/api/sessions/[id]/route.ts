import { clearSession, RelayError } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    clearSession(id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof RelayError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "Failed to clear session" }, { status: 500 });
  }
}
