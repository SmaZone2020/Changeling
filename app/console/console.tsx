"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FinishReason, PublicState, Session, StateEnvelope, Turn } from "@/lib/types";
import { duration, timeAgo } from "@/lib/format";
import TopBar from "@/components/console/top-bar";
import SessionList from "@/components/console/session-list";
import Thread from "@/components/console/thread";
import Composer from "@/components/console/composer";
import ConnectDrawer from "@/components/console/connect-drawer";
import { useDrafts } from "@/components/console/use-drafts";

const POLL_MS = 900;

export default function Console() {
  const [state, setState] = useState<PublicState | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const revisionRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const pinnedTurnRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drafts = useDrafts();

  activeIdRef.current = activeId;

  const notify = useCallback((text: string, err = false) => {
    setToast({ text, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  /* ------------------------------ polling ------------------------------ */

  const applyState = useCallback((next: PublicState) => {
    revisionRef.current = next.revision;
    setState(next);

    const sessions = next.sessions;
    const current = activeIdRef.current;
    const stillExists = sessions.some((s) => s.id === current);
    if (!stillExists && sessions.length) {
      activeIdRef.current = sessions[0].id;
      setActiveId(sessions[0].id);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch(`/api/state?since=${revisionRef.current}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as PublicState | StateEnvelope;
          if (!cancelled && "sessions" in data) applyState(data);
        }
      } catch {
        /* transient */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [applyState]);

  /* ------------------------------ derived ------------------------------ */

  const active = useMemo(
    () => state?.sessions.find((s) => s.id === activeId) ?? state?.sessions[0] ?? null,
    [state, activeId],
  );

  const pendingTurns = useMemo(
    () => (active ? active.turns.filter((t) => t.status === "pending") : []),
    [active],
  );

  // Follow whichever turn is newest unless the operator explicitly picked one.
  const activeTurn: Turn | null = useMemo(() => {
    if (!pendingTurns.length) return null;
    const pinned = pendingTurns.find((t) => t.id === selectedTurnId);
    if (pinned) return pinned;
    return pendingTurns[pendingTurns.length - 1];
  }, [pendingTurns, selectedTurnId]);

  useEffect(() => {
    if (activeTurn && pinnedTurnRef.current !== activeTurn.id) {
      pinnedTurnRef.current = activeTurn.id;
      setSelectedTurnId(null);
    }
  }, [activeTurn]);

  const pendingCount = useMemo(
    () => state?.sessions.reduce((n, s) => n + s.turns.filter((t) => t.status === "pending").length, 0) ?? 0,
    [state],
  );

  const lastActivity = useMemo(() => {
    if (!active) return null;
    const turn = active.turns[active.turns.length - 1];
    return turn?.createdAt ?? active.updatedAt;
  }, [active]);

  /* ------------------------------ actions ------------------------------ */

  const submit = useCallback(
    async (
      turnId: string,
      payload: {
        content: string;
        toolCalls: Array<{ name: string; arguments: string }>;
        finishReason?: FinishReason;
      },
    ) => {
      const res = await fetch(`/api/turns/${encodeURIComponent(turnId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Reply rejected (${res.status})`);
      }
      setSelectedTurnId(null);
      notify(
        payload.toolCalls.length
          ? `Sent ${payload.toolCalls.length} tool call${payload.toolCalls.length > 1 ? "s" : ""} to ${active?.agent ?? "agent"}`
          : "Reply delivered to agent",
      );
    },
    [active, notify],
  );

  const cancelTurn = useCallback(
    async (turnId: string) => {
      const res = await fetch(`/api/turns/${encodeURIComponent(turnId)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Could not cancel the turn");
      }
      notify("Turn cancelled — the agent received an abort");
    },
    [notify],
  );

  const clearSession = useCallback(
    async (sessionId: string) => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      if (!res.ok) {
        notify("Could not clear the session", true);
        return;
      }
      notify("Session cleared");
    },
    [notify],
  );

  /* ------------------------------ render ------------------------------ */

  const now = state?.now ?? Date.now();

  return (
    <div className="shell">
      <TopBar
        sessionCount={state?.sessions.length ?? 0}
        pendingCount={pendingCount}
        onConnect={() => setDrawerOpen(true)}
      />

      <SessionList
        sessions={state?.sessions ?? []}
        activeId={active?.id ?? null}
        now={now}
        onSelect={(id) => {
          setActiveId(id);
          setSelectedTurnId(null);
        }}
      />

      <main className="main">
        {active ? (
          <>
            <header className="session-head">
              <div className="session-head-title">
                <h1>{active.title}</h1>
                <div className="session-head-sub">
                  <span>{active.agent}</span>
                  <i className="sep" />
                  <span>{active.model}</span>
                  <i className="sep" />
                  <span>
                    key <b style={{ color: "var(--ink-dim)" }}>{active.apiKeyHint}</b>
                  </span>
                  <i className="sep" />
                  <span>{active.messages.length} msgs</span>
                  <i className="sep" />
                  <span>{active.tools.length} tools</span>
                  {lastActivity && (
                    <>
                      <i className="sep" />
                      <span>{timeAgo(lastActivity, now)}</span>
                    </>
                  )}
                </div>
              </div>
              <button
                className="icon-btn ghost"
                onClick={() => {
                  if (confirm(`Clear session "${active.title}"? Pending turns will be aborted.`)) {
                    void clearSession(active.id);
                  }
                }}
                title="Clear session"
              >
                Clear
              </button>
            </header>

            <Thread session={active} pendingTurn={activeTurn} now={now} />

            {pendingTurns.length > 1 && (
              <div className="queue-tabs">
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 9.5,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    color: "var(--ink-faint)",
                    alignSelf: "center",
                    marginRight: 4,
                  }}
                >
                  Queue
                </span>
                {pendingTurns.map((t, i) => (
                  <button
                    key={t.id}
                    className={`queue-tab${activeTurn?.id === t.id ? " active" : ""}`}
                    onClick={() => setSelectedTurnId(t.id)}
                  >
                    #{i + 1} · {duration(now - t.createdAt)}
                  </button>
                ))}
              </div>
            )}

            {activeTurn ? (
              <Composer
                key={activeTurn.id}
                turn={activeTurn}
                session={active}
                now={now}
                initialDraft={drafts.get(activeTurn.id)}
                onDraftChange={(draft) => drafts.set(activeTurn.id, draft)}
                onSubmit={async (payload) => {
                  await submit(activeTurn.id, payload);
                  drafts.drop(activeTurn.id);
                }}
                onCancel={async () => {
                  await cancelTurn(activeTurn.id);
                  drafts.drop(activeTurn.id);
                }}
                onError={(msg) => notify(msg, true)}
              />
            ) : (
              <div
                style={{
                  padding: "12px 22px 16px",
                  borderTop: "1px solid var(--line)",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: "var(--ink-faint)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span className="pulse-dot green" />
                Idle — waiting for the agent to send its next request
              </div>
            )}
          </>
        ) : (
          <EmptyState onConnect={() => setDrawerOpen(true)} />
        )}
      </main>

      {drawerOpen && <ConnectDrawer onClose={() => setDrawerOpen(false)} />}
      {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.text}</div>}
    </div>
  );
}

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="waiting" style={{ flex: 1 }}>
      <div className="glyph">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 7h16M4 12h10M4 17h13" strokeLinecap="round" />
        </svg>
      </div>
      <h2>No agent connected yet</h2>
      <p>
        Point OpenCode, Claude Code, or any OpenAI-compatible agent at this relay. Every request parks
        here and waits for you to write the assistant turn and choose the tool calls.
      </p>
      <button className="btn-primary" onClick={onConnect} style={{ marginTop: 4 }}>
        Get connection config
      </button>
    </div>
  );
}

export type { Session };
