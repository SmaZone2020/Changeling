"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FinishReason, Session, Turn } from "@/lib/types";
import { duration, partialJSONError, prettyJSON, recentCalls, schemaTemplate } from "@/lib/format";
import type { Draft } from "./use-drafts";

interface DraftCall {
  key: string;
  name: string;
  args: string;
}

export default function Composer({
  turn,
  session,
  now,
  initialDraft,
  onDraftChange,
  onSubmit,
  onCancel,
  onError,
}: {
  turn: Turn;
  session: Session;
  now: number;
  initialDraft: Draft;
  onDraftChange: (draft: Draft) => void;
  onSubmit: (payload: {
    content: string;
    toolCalls: Array<{ name: string; arguments: string }>;
    finishReason?: FinishReason;
  }) => Promise<void>;
  onCancel: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [content, setContent] = useState(initialDraft.content);
  const [calls, setCalls] = useState<DraftCall[]>(initialDraft.calls);  const [busy, setBusy] = useState(false);
  const [finish, setFinish] = useState<FinishReason>(initialDraft.finish);
  const [toolFilter, setToolFilter] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const remaining = turn.expiresAt - now;

  useEffect(() => {
    onDraftChange({ content, calls, finish });
  }, [content, calls, finish, onDraftChange]);

  const tools = useMemo(
    () => session.tools.filter((t) => t.function?.name),
    [session.tools],
  );

  const history = useMemo(() => {
    const prior = session.messages.slice(0, -1);
    return recentCalls(prior, 6);
  }, [session.messages]);

  const filteredTools = useMemo(() => {
    const q = toolFilter.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.function.name.toLowerCase().includes(q) ||
        (t.function.description ?? "").toLowerCase().includes(q),
    );
  }, [tools, toolFilter]);

  const invalidCalls = calls.filter((c) => partialJSONError(c.args) !== null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const addCall = (name: string, args?: string) => {
    const tool = tools.find((t) => t.function.name === name);
    setCalls((prev) => [
      ...prev,
      {
        key: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        args: args ?? schemaTemplate(tool),
      },
    ]);
    setFinish("tool_calls");
  };

  const updateCall = (key: string, patch: Partial<DraftCall>) => {
    setCalls((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  };

  const removeCall = (key: string) => {
    setCalls((prev) => prev.filter((c) => c.key !== key));
  };

  const submit = async () => {
    if (busy) return;
    if (!content.trim() && calls.length === 0) {
      onError("Write a reply or add a tool call first.");
      return;
    }
    const bad = calls.find((c) => partialJSONError(c.args) !== null);
    if (bad) {
      onError(`Arguments for "${bad.name || "unnamed"}" are not valid JSON.`);
      return;
    }
    const named = calls.find((c) => !c.name.trim());
    if (named) {
      onError("Every tool call needs a name.");
      return;
    }

    setBusy(true);
    try {
      await onSubmit({
        content,
        toolCalls: calls.map((c) => ({
          name: c.name.trim(),
          arguments: prettyJSON(c.args) || "{}",
        })),
        finishReason: deriveFinish(finish, calls.length),
      });
      setContent("");
      setCalls([]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await onCancel();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div style={{ padding: "0 22px 18px" }}>
      <div className="pending-wrap">
        <div className="pending-head">
          <span className="pulse-dot" />
          <span>Turn awaiting you</span>
          <span className="clock">{formatRemaining(remaining)} left</span>
          <span className="turn-id">
            {turn.id.replace("turn_", "").slice(0, 8)} · {duration(now - turn.createdAt)}
          </span>
        </div>

        {tools.length > 0 ? (
          <div className="pending-tools">
            <span className="label">Declared tools</span>
            {tools.length > 6 && (
              <input
                value={toolFilter}
                onChange={(e) => setToolFilter(e.target.value)}
                placeholder="filter…"
                style={{
                  height: 24,
                  width: 96,
                  padding: "0 7px",
                  border: "1px solid var(--line)",
                  borderRadius: 5,
                  background: "var(--bg-inset)",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  outline: "none",
                }}
              />
            )}
            {filteredTools.map((tool) => {
              const used = calls.some((c) => c.name === tool.function.name);
              return (
                <button
                  key={tool.function.name}
                  className={`tool-chip${used ? " used" : ""}`}
                  onClick={() => addCall(tool.function.name)}
                  title={tool.function.description || tool.function.name}
                >
                  {tool.function.name}
                </button>
              );
            })}
            <button
              className="tool-chip custom"
              onClick={() => addCall("", "{}")}
              title="Call a tool that this agent did not declare"
            >
              + custom
            </button>
          </div>
        ) : (
          <div className="pending-tools">
            <span className="label">No tools declared</span>
            <button className="tool-chip custom" onClick={() => addCall("", "{}")}>
              + custom tool call
            </button>
          </div>
        )}

        {history.length > 0 && (
          <div className="pending-tools" style={{ borderTop: "none", paddingTop: 0 }}>
            <span className="label">Replay</span>
            {history.map((call) => (
              <button
                key={`${call.name}-${call.arguments}`}
                className="tool-chip"
                onClick={() => addCall(call.name, call.arguments)}
                title={call.arguments}
              >
                {call.name}
                <span style={{ color: "var(--ink-faint)", marginLeft: 4 }}>
                  {shortArgs(call.arguments)}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="composer">
          <div>
            <div className="field-label">
              <span>Assistant content</span>
              <span style={{ textTransform: "none", letterSpacing: 0 }}>
                markdown, optional when calling tools
              </span>
            </div>
            <textarea
              ref={textRef}
              className="reply"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                calls.length
                  ? "Optional: say something before the tool call runs…"
                  : "Write the assistant turn. This text goes back to the agent verbatim."
              }
            />
          </div>

          {calls.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="field-label">
                <span>Tool calls ({calls.length})</span>
                <span style={{ textTransform: "none", letterSpacing: 0 }}>
                  you control name + arguments
                </span>
              </div>
              {calls.map((call, i) => {
                const err = partialJSONError(call.args);
                return (
                  <div className={`draft-call${err ? " invalid" : ""}`} key={call.key}>
                    <div className="draft-call-head">
                      <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                      <input
                        className="fn-input"
                        value={call.name}
                        onChange={(e) => updateCall(call.key, { name: e.target.value })}
                        placeholder="tool_name"
                        spellCheck={false}
                        list={`tools-${turn.id}`}
                      />
                      <datalist id={`tools-${turn.id}`}>
                        {tools.map((t) => (
                          <option key={t.function.name} value={t.function.name} />
                        ))}
                      </datalist>
                      <button
                        className="mini-btn"
                        onClick={() => updateCall(call.key, { args: prettyJSON(call.args) })}
                        title="Reformat JSON"
                      >
                        fmt
                      </button>
                      <button
                        className="mini-btn danger"
                        onClick={() => removeCall(call.key)}
                        title="Remove this call"
                      >
                        del
                      </button>
                    </div>
                    <textarea
                      className="args"
                      value={call.args}
                      onChange={(e) => updateCall(call.key, { args: e.target.value })}
                      placeholder='{ "path": "/src/app.tsx" }'
                      spellCheck={false}
                      rows={Math.min(10, Math.max(3, call.args.split("\n").length))}
                    />
                    {err && <div className="arg-error">JSON error — {err}</div>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="composer-actions">
            <button className="btn-primary" onClick={submit} disabled={busy || invalidCalls.length > 0}>
              {busy ? "Sending…" : calls.length ? "Send tool calls" : "Send reply"}
              <span className="kbd">⌘↵</span>
            </button>
            <select
              className="finish-select"
              value={finish}
              onChange={(e) => setFinish(e.target.value as FinishReason)}
              title="finish_reason"
            >
              <option value="tool_calls">finish: tool_calls</option>
              <option value="stop">finish: stop</option>
              <option value="length">finish: length</option>
            </select>
            <button className="icon-btn ghost" onClick={cancel} disabled={busy}>
              Abort turn
            </button>
            <span className="composer-hint">
              {calls.length > 0
                ? `${calls.length} call${calls.length > 1 ? "s" : ""} · agent executes them locally`
                : "no tool calls · agent gets plain text"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function shortArgs(raw: string): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text || text === "{}") return "";
  return text.length > 26 ? `${text.slice(0, 26)}…` : text;
}

function deriveFinish(chosen: FinishReason, callCount: number): FinishReason {  if (chosen === "tool_calls" && callCount === 0) return "stop";
  if (chosen === "stop" && callCount > 0) return "tool_calls";
  return chosen;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
