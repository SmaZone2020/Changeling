"use client";

import type { Session } from "@/lib/types";
import { timeAgo } from "@/lib/format";

export default function SessionList({
  sessions,
  activeId,
  now,
  onSelect,
}: {
  sessions: Session[];
  activeId: string | null;
  now: number;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>Sessions</span>
        <span>{sessions.length ? `${sessions.length} live` : "idle"}</span>
      </div>

      <div className="sidebar-list">
        {sessions.length === 0 && (
          <div
            style={{
              padding: "18px 10px",
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--ink-faint)",
            }}
          >
            Nothing connected. Requests from your agent will appear here the moment they arrive.
          </div>
        )}

        {sessions.map((session) => {
          const pending = session.turns.filter((t) => t.status === "pending").length;
          const isActive = session.id === activeId;
          return (
            <button
              key={session.id}
              className={`session-item${isActive ? " active" : ""}`}
              onClick={() => onSelect(session.id)}
            >
              <div className="session-row">
                {pending > 0 ? (
                  <span className="pulse-dot" />
                ) : (
                  <span className="pulse-dot green" style={{ opacity: 0.55 }} />
                )}
                <span className={`agent-chip${pending > 0 ? " live" : ""}`}>{session.agent}</span>
              </div>
              <div className="session-title">{session.title}</div>
              <div className="session-meta">
                <span>{session.messages.length} msgs</span>
                <span>·</span>
                <span>{timeAgo(session.updatedAt, now)}</span>
                {pending > 0 && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--amber)" }}>
                      {pending} waiting
                    </span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <div className="key-line">
          <span>API key</span>
          <span className="key-pill">any value</span>
        </div>
        <div className="key-line">
          <span>Timeout</span>
          <span className="key-pill">15 min / turn</span>
        </div>
      </div>
    </aside>
  );
}
