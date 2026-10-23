import { snapshot } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lightweight state feed for the console. Supports cheap revision polling. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") || 0);
  const state = snapshot(since || null);
  return Response.json(state, {
    headers: { "cache-control": "no-store" },
  });
}
