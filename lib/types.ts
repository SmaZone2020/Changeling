/** Shared types for Changeling. Imported by both server and client code. */

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON encoded object, exactly as OpenAI sends it. */
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

/** What the operator composes in the WebUI. */
export interface ReplyDraft {
  content: string;
  toolCalls: Array<{ name: string; arguments: string }>;
}

export type TurnStatus =
  | "pending"
  | "answered"
  | "expired"
  | "cancelled"
  | "failed";

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface Turn {
  id: string;
  sessionId: string;
  status: TurnStatus;
  createdAt: number;
  expiresAt: number;
  answeredAt?: number;
  finishReason?: FinishReason;
  reply?: {
    content: string;
    toolCalls: ToolCall[];
  };
  error?: string;
  meta: {
    model: string;
    stream: boolean;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    toolChoice?: unknown;
    messageCount: number;
    hasTools: boolean;
    parallelToolCalls?: boolean;
  };
}

export interface Session {
  id: string;
  apiKeyHint: string;
  agent: string;
  model: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  tools: ToolDef[];
  turns: Turn[];
}

export interface ChangelingConfig {
  timeoutMs: number;
  authEnforced: boolean;
  endpoint: string;
}

export interface PublicState {
  revision: number;
  now: number;
  sessions: Session[];
  config: ChangelingConfig;
}

export interface StateEnvelope {
  unchanged: true;
  revision: number;
}

export type StateResponse = PublicState | StateEnvelope;
