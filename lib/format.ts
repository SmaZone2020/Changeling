import type { ChatMessage, ToolCall, ToolDef } from "./types";

export function timeAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        if (p.type === "image_url") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function prettyJSON(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function isJSON(raw: string): boolean {
  const text = (raw ?? "").trim();
  if (!text) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function partialJSONError(raw: string): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid JSON";
  }
}

/** Build a starter JSON object from a tool's JSON Schema. */
export function schemaTemplate(tool: ToolDef | undefined): string {
  const params = tool?.function?.parameters as
    | {
        properties?: Record<string, { type?: string; description?: string; enum?: unknown[]; default?: unknown }>;
        required?: string[];
      }
    | undefined;
  if (!params?.properties) return "{}";
  const required = new Set(params.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(params.properties)) {
    if (required.size > 0 && !required.has(key)) continue;
    out[key] = sampleFor(spec);
  }
  if (!Object.keys(out).length) {
    for (const [key, spec] of Object.entries(params.properties)) out[key] = sampleFor(spec);
  }
  return JSON.stringify(out, null, 2);
}

function sampleFor(spec: { type?: string; enum?: unknown[]; default?: unknown } | undefined): unknown {
  if (!spec) return "";
  if (spec.default !== undefined) return spec.default;
  if (Array.isArray(spec.enum) && spec.enum.length) return spec.enum[0];
  switch (spec.type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

export function callNameMap(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      map.set(call.id, call.function.name);
    }
  }
  return map;
}

/** Previous tool calls in this session, newest first, deduped by name+args. */
export function recentCalls(
  messages: ChatMessage[],
  limit = 6,
): Array<{ name: string; arguments: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; arguments: string }> = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    for (const call of messages[i].tool_calls ?? []) {
      const key = `${call.function.name}\u0000${call.function.arguments}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: call.function.name, arguments: call.function.arguments });
    }
  }
  return out;
}

export function toCalls(raw: Array<{ name: string; arguments: string }>): ToolCall[] {
  return raw.map((c, i) => ({
    id: `draft-${i}`,
    type: "function" as const,
    function: { name: c.name, arguments: c.arguments },
  }));
}

export function copy(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error("clipboard unavailable"));
}
