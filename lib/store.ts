import { createHash, randomUUID } from "node:crypto";
import type {
  ChatMessage,
  FinishReason,
  PublicState,
  RelayConfig,
  Session,
  ToolCall,
  ToolDef,
  Turn,
} from "./types";

/**
 * In-memory relay store.
 *
 * A pending turn holds an HTTP response open. The resolver for that response
 * lives here, outside React/Next, keyed by turn id. Everything is pinned to
 * globalThis so dev-mode module reloads don't orphan an in-flight request.
 */

const TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS || 15 * 60 * 1000);
const MAX_SESSIONS = 50;
const MAX_TURNS_PER_SESSION = 60;
const MAX_PENDING_PER_SESSION = 8;
const TERMINAL_RETENTION_MS = 1000 * 60 * 60 * 12;

type Resolver = {
  resolve: (turn: Turn) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Detaches the client-abort listener so it can't outlive the request. */
  detach: () => void;
};

interface StoreShape {
  sessions: Map<string, Session>;
  resolvers: Map<string, Resolver>;
  order: string[];
  revision: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __relayStore: StoreShape | undefined;
}

function store(): StoreShape {
  if (!globalThis.__relayStore) {
    globalThis.__relayStore = {
      sessions: new Map(),
      resolvers: new Map(),
      order: [],
      revision: 1,
    };
  }
  return globalThis.__relayStore;
}

function bump() {
  store().revision += 1;
}

export function revision() {
  return store().revision;
}

export function config(): RelayConfig {
  return {
    timeoutMs: TIMEOUT_MS,
    authEnforced: Boolean(process.env.CONSOLE_API_KEYS?.trim()),
    endpoint: "/v1/chat/completions",
  };
}

/* ------------------------------------------------------------------ */
/* identity                                                            */
/* ------------------------------------------------------------------ */

export function deriveSessionId(
  apiKey: string,
  messages: ChatMessage[],
  explicit?: string | null,
): string {
  const seed = explicit?.trim()
    ? `explicit:${explicit.trim()}`
    : [
        // The system prompt plus the first user message is a stable fingerprint
        // for a conversation: it survives every later round-trip.
        firstText(messages.find((m) => m.role === "system")?.content),
        firstText(messages.find((m) => m.role === "user")?.content),
      ].join("\u0000");
  return createHash("sha256").update(seed).digest("hex").slice(0, 12);
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join(" ");
  }
  return "";
}

function keyHint(auth: string | null): string {
  if (!auth) return "none";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token.length <= 6) return token;
  return `…${token.slice(-6)}`;
}

function titleFor(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user");
  const text = firstText(user?.content).replace(/\s+/g, " ").trim();
  if (!text) return "Untitled session";
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

export function checkAuth(header: string | null): { ok: boolean; hint: string } {
  const raw = process.env.CONSOLE_API_KEYS?.trim();
  if (!raw) return { ok: true, hint: keyHint(header) };
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const token = (header || "").replace(/^Bearer\s+/i, "").trim();
  return { ok: allowed.includes(token), hint: keyHint(header) };
}

/* ------------------------------------------------------------------ */
/* session lifecycle                                                   */
/* ------------------------------------------------------------------ */

function touchOrder(id: string) {
  const s = store();
  const i = s.order.indexOf(id);
  if (i !== -1) s.order.splice(i, 1);
  s.order.unshift(id);
}

function prune() {
  const s = store();
  while (s.order.length > MAX_SESSIONS) {
    const victim = s.order.pop();
    if (!victim) break;
    const session = s.sessions.get(victim);
    session?.turns.forEach((t) => {
      const r = s.resolvers.get(t.id);
      if (r) {
        clearTimeout(r.timer);
        s.resolvers.delete(t.id);
        r.reject(new Error("session pruned"));
      }
    });
    s.sessions.delete(victim);
  }
}

function pruneTurns(session: Session) {
  const cutoff = Date.now() - TERMINAL_RETENTION_MS;
  session.turns = session.turns.filter(
    (t) => t.status === "pending" || (t.answeredAt ?? t.createdAt) > cutoff,
  );
  if (session.turns.length > MAX_TURNS_PER_SESSION) {
    const pending = session.turns.filter((t) => t.status === "pending");
    const done = session.turns
      .filter((t) => t.status !== "pending")
      .slice(-(MAX_TURNS_PER_SESSION - pending.length));
    session.turns = [...done, ...pending].sort((a, b) => a.createdAt - b.createdAt);
  }
}

/* ------------------------------------------------------------------ */
/* request intake                                                      */
/* ------------------------------------------------------------------ */

export interface IntakeInput {
  apiKey: string;
  agent: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  stream: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  explicitSession?: string | null;
  signal?: AbortSignal;
}

export interface IntakeResult {
  session: Session;
  turn: Turn;
  /** Resolves when the operator submits a reply; rejects on timeout/abort. */
  outcome: Promise<Turn>;
}

export function intake(input: IntakeInput): IntakeResult {
  const s = store();
  const id = deriveSessionId(input.apiKey, input.messages, input.explicitSession);
  const now = Date.now();

  let session = s.sessions.get(id);
  if (!session) {
    session = {
      id,
      apiKeyHint: input.apiKey,
      agent: input.agent,
      model: input.model,
      title: titleFor(input.messages),
      createdAt: now,
      updatedAt: now,
      messages: [],
      tools: [],
      turns: [],
    };
    s.sessions.set(id, session);
  }

  session.agent = input.agent || session.agent;
  session.model = input.model || session.model;
  session.updatedAt = now;
  if (input.tools.length) session.tools = input.tools;
  // Only ever grow the transcript: a retried/stale request must not erase
  // messages the operator already answered.
  if (input.messages.length >= session.messages.length) {
    session.messages = input.messages;
  }
  if (session.title === "Untitled session") session.title = titleFor(input.messages);

  const pending = session.turns.filter((t) => t.status === "pending");
  if (pending.length >= MAX_PENDING_PER_SESSION) {
    for (const stale of pending.slice(0, pending.length - MAX_PENDING_PER_SESSION + 1)) {
      failTurn(stale, "Too many queued requests for this session");
    }
  }

  const turn: Turn = {
    id: `turn_${randomUUID()}`,
    sessionId: session.id,
    status: "pending",
    createdAt: now,
    expiresAt: now + TIMEOUT_MS,
    meta: {
      model: input.model,
      stream: input.stream,
      temperature: input.temperature,
      topP: input.topP,
      maxTokens: input.maxTokens,
      toolChoice: input.toolChoice,
      messageCount: input.messages.length,
      hasTools: input.tools.length > 0,
      parallelToolCalls: input.parallelToolCalls,
    },
  };
  session.turns.push(turn);
  pruneTurns(session);
  touchOrder(session.id);
  prune();
  bump();

  const outcome = new Promise<Turn>((resolve, reject) => {
    let settled = false;
    let detach = () => {};

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      detach();
      fn();
    };

    const timer = setTimeout(() => {
      const t = s.sessions.get(session!.id)?.turns.find((x) => x.id === turn.id);
      if (!t || t.status !== "pending") return;
      settle(() => {
        t.status = "expired";
        t.error = "Operator did not respond before the deadline";
        s.resolvers.delete(turn.id);
        bump();
        reject(new RelayTimeout(t.error));
      });
    }, TIMEOUT_MS);

    if (input.signal) {
      const onAbort = () => {
        const t = s.sessions.get(session!.id)?.turns.find((x) => x.id === turn.id);
        if (!t || t.status !== "pending") return;
        settle(() => {
          t.status = "cancelled";
          t.error = "Client disconnected";
          s.resolvers.delete(turn.id);
          bump();
          reject(new RelayAbort("Client disconnected"));
        });
      };
      if (input.signal.aborted) onAbort();
      else {
        input.signal.addEventListener("abort", onAbort, { once: true });
        detach = () => input.signal?.removeEventListener("abort", onAbort);
      }
    }

    s.resolvers.set(turn.id, {
      resolve: (t) => settle(() => resolve(t)),
      reject: (e) => settle(() => reject(e)),
      timer,
      detach,
    });
  });

  return { session, turn, outcome };
}

export class RelayTimeout extends Error {}
export class RelayAbort extends Error {}

function failTurn(turn: Turn, reason: string) {
  const s = store();
  turn.status = "failed";
  turn.error = reason;
  const r = s.resolvers.get(turn.id);
  if (r) {
    clearTimeout(r.timer);
    s.resolvers.delete(turn.id);
    r.reject(new Error(reason));
  }
  bump();
}

/* ------------------------------------------------------------------ */
/* answering                                                           */
/* ------------------------------------------------------------------ */

export interface AnswerInput {
  content: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  /** Force a specific finish reason; otherwise inferred. */
  finishReason?: FinishReason;
}

export function findTurn(turnId: string): { session: Session; turn: Turn } | null {
  for (const session of store().sessions.values()) {
    const turn = session.turns.find((t) => t.id === turnId);
    if (turn) return { session, turn };
  }
  return null;
}

export function answer(turnId: string, input: AnswerInput): Turn {
  const s = store();
  const found = findTurn(turnId);
  if (!found) throw new RelayError(404, "turn_not_found", "No such turn");
  const { session, turn } = found;
  if (turn.status !== "pending") {
    throw new RelayError(409, "turn_not_pending", `Turn is ${turn.status}`);
  }

  const toolCalls: ToolCall[] = input.toolCalls
    .filter((c) => c.name.trim())
    .map((c) => ({
      id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function" as const,
      function: {
        name: c.name.trim(),
        arguments: normalizeArgs(c.arguments),
      },
    }));

  const content = input.content ?? "";
  const finishReason: FinishReason =
    input.finishReason ?? (toolCalls.length ? "tool_calls" : "stop");

  turn.status = "answered";
  turn.answeredAt = Date.now();
  turn.finishReason = finishReason;
  turn.reply = { content, toolCalls };

  // Fold the operator's turn into the transcript immediately, so the UI keeps
  // showing it during the gap before the agent's next request arrives.
  const assistant: ChatMessage = { role: "assistant", content: content || null };
  if (toolCalls.length) assistant.tool_calls = toolCalls;
  session.messages = [...session.messages, assistant];
  session.updatedAt = Date.now();

  const resolver = s.resolvers.get(turn.id);
  if (resolver) {
    clearTimeout(resolver.timer);
    s.resolvers.delete(turn.id);
    resolver.resolve(turn);
  }
  bump();
  return turn;
}

export function cancelTurn(turnId: string, reason = "Cancelled by operator"): Turn {
  const s = store();
  const found = findTurn(turnId);
  if (!found) throw new RelayError(404, "turn_not_found", "No such turn");
  const { turn } = found;
  if (turn.status !== "pending") {
    throw new RelayError(409, "turn_not_pending", `Turn is ${turn.status}`);
  }
  turn.status = "cancelled";
  turn.error = reason;
  const r = s.resolvers.get(turn.id);
  if (r) {
    clearTimeout(r.timer);
    s.resolvers.delete(turn.id);
    r.reject(new Error(reason));
  }
  bump();
  return turn;
}

export function clearSession(sessionId: string) {
  const s = store();
  const session = s.sessions.get(sessionId);
  if (!session) throw new RelayError(404, "session_not_found", "No such session");
  for (const t of session.turns) {
    if (t.status === "pending") cancelTurn(t.id);
  }
  s.sessions.delete(sessionId);
  s.order = s.order.filter((x) => x !== sessionId);
  bump();
}

function normalizeArgs(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "{}";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
    return JSON.stringify({ value: parsed });
  } catch {
    // Keep malformed input verbatim: the agent should see exactly what the
    // operator wrote, including the parse failure it will report back.
    return text;
  }
}

export class RelayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* snapshots                                                           */
/* ------------------------------------------------------------------ */

export function snapshot(sinceRevision?: number | null): PublicState | { unchanged: true; revision: number } {
  const s = store();
  if (sinceRevision && sinceRevision === s.revision) {
    return { unchanged: true, revision: s.revision };
  }
  const sessions = s.order
    .map((id) => s.sessions.get(id))
    .filter((x): x is Session => Boolean(x));
  return {
    revision: s.revision,
    now: Date.now(),
    sessions,
    config: config(),
  };
}

export function getSession(sessionId: string): Session | null {
  return store().sessions.get(sessionId) ?? null;
}
