"use client";

export default function TopBar({
  sessionCount,
  pendingCount,
  onConnect,
}: {
  sessionCount: number;
  pendingCount: number;
  onConnect: () => void;
}) {
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark" />
        <div className="brand-text">
          <span className="brand-name">RELAY</span>
          <span className="brand-sub">human in the loop</span>
        </div>
      </div>

      <div className="endpoint" title="OpenAI-compatible base URL">
        <span className="verb">POST</span>
        <span className="path">/v1/chat/completions</span>
      </div>

      <div className="topbar-spacer" />

      <div className="stat">
        <b>{sessionCount}</b>
        <span>sessions</span>
      </div>
      <div className={`stat${pendingCount ? " hot" : ""}`}>
        <b>{pendingCount}</b>
        <span>pending</span>
      </div>

      <button className="icon-btn" onClick={onConnect}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3v18M3 12h18" strokeLinecap="round" />
        </svg>
        Connect agent
      </button>
    </div>
  );
}
