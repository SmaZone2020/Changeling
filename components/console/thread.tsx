"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Session, Turn } from "@/lib/types";
import { callNameMap, prettyJSON, textOf } from "@/lib/format";

export default function Thread({
  session,
  pendingTurn,
  now,
}: {
  session: Session;
  pendingTurn: Turn | null;
  now: number;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [expandSystem, setExpandSystem] = useState(false);

  const names = useMemo(() => callNameMap(session.messages), [session.messages]);
  const visible = useMemo(
    () => session.messages.filter((m) => m.role !== "system" && m.role !== "developer"),
    [session.messages],
  );
  const systemMsgs = useMemo(
    () => session.messages.filter((m) => m.role === "system" || m.role === "developer"),
    [session.messages],
  );

  useEffect(() => {
    if (!pinned) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [pinned, session.messages.length, pendingTurn?.id]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < 90);
  };

  return (
    <div className="scroll-area" ref={scrollerRef} onScroll={onScroll}>
      <div className="thread">
        {systemMsgs.length > 0 && (
          <div className={`msg system${expandSystem ? "" : " collapsed-system"}`}>
            <div className="msg-label">
              <span className="who system">System prompt</span>
              <button
                className="mini-btn"
                onClick={() => setExpandSystem((v) => !v)}
                style={{ marginLeft: "auto" }}
              >
                {expandSystem ? "collapse" : "expand"}
              </button>
            </div>
            <div className="msg-body">{systemMsgs.map((m) => textOf(m.content)).join("\n\n")}</div>
          </div>
        )}

        {visible.length === 0 && !pendingTurn && (
          <div className="waiting" style={{ padding: "40px 20px" }}>
            <p>Transcript will appear here as the agent sends messages.</p>
          </div>
        )}

        {visible.map((msg, i) => (
          <MessageRow key={i} msg={msg} names={names} />
        ))}

        <div ref={bottomRef} />
      </div>

      {!pinned && (
        <button
          className="icon-btn"
          onClick={() => {
            setPinned(true);
            bottomRef.current?.scrollIntoView({ block: "end" });
          }}
          style={{ position: "sticky", bottom: 16, left: "50%", transform: "translateX(-50%)" }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}

function MessageRow({ msg, names }: { msg: ChatMessage; names: Map<string, string> }) {
  if (msg.role === "tool") {
    const name = (msg.name as string) || names.get(msg.tool_call_id ?? "") || "tool";
    const body = textOf(msg.content);
    return (
      <div className="msg">
        <div className="tool-result">
          <div className="tool-result-head">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--signal)" strokeWidth="2.4">
              <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="ok">result</span>
            <span className="name">{name}</span>
            <span className="id">{msg.tool_call_id}</span>
          </div>
          <pre>{prettyJSON(body) || "(empty)"}</pre>
        </div>
      </div>
    );
  }

  const body = textOf(msg.content);
  const calls = msg.tool_calls ?? [];
  if (msg.role === "user") {
    return (
      <div className="msg user">
        <div className="msg-label">
          <span className="who user">Agent input</span>
        </div>
        <div className="msg-body">{body || "(no text)"}</div>
      </div>
    );
  }

  return (
    <div className="msg assistant mine">
      <div className="msg-label">
        <span className="who assistant">You</span>
        {calls.length > 0 && <span style={{ color: "var(--violet)" }}>· {calls.length} tool call{calls.length > 1 ? "s" : ""}</span>}
      </div>
      {body && <div className="msg-body">{body}</div>}
      {calls.length > 0 && (
        <div className="call-block">
          {calls.map((call) => (
            <div className="call-card" key={call.id}>
              <div className="call-card-head">
                <span className="fn">{call.function.name}</span>
                <span className="badge">{call.id.slice(0, 12)}</span>
              </div>
              <pre>{prettyJSON(call.function.arguments)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
