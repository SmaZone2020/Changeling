import { checkAuth } from "@/lib/store";
import { errorBody } from "@/lib/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = checkAuth(req.headers.get("authorization"));
  if (!gate.ok) {
    return errorBody(401, "Invalid API key for this relay.", "invalid_api_key", "authentication_error");
  }
  const created = Math.floor(Date.now() / 1000);
  const model = (id: string, name: string) => ({
    id,
    object: "model",
    created,
    owned_by: "relay-human-in-the-loop",
    name,
  });
  return Response.json({
    object: "list",
    data: [
      model("relay-human", "Human operator (this console)"),
      model("relay-human-fast", "Human operator, terse replies"),
      model("relay-human-thorough", "Human operator, detailed replies"),
    ],
  });
}
