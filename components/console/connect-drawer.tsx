"use client";

import { useMemo, useState } from "react";
import { copy } from "@/lib/format";

const TABS = ["OpenCode", "cURL", "Python", "Protocol"] as const;
type Tab = (typeof TABS)[number];

export default function ConnectDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("OpenCode");
  const [copied, setCopied] = useState<string | null>(null);
  const origin = useMemo(() => {
    if (typeof window === "undefined") return "http://localhost:3000";
    return window.location.origin;
  }, []);

  const baseUrl = `${origin}/v1`;

  const doCopy = async (text: string, tag: string) => {
    try {
      await copy(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const snippets: Record<Tab, { label: string; code: string; tag: string }[]> = {
    OpenCode: [
      {
        label: "opencode.json",
        tag: "opencode",
        code: JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            provider: {
              changeling: {
                npm: "@ai-sdk/openai-compatible",
                name: "Changeling",
                options: { baseURL: baseUrl, apiKey: "changeling-local" },
                models: {
                  "changeling-human": { name: "Human operator" },
                },
              },
            },
            model: "changeling/changeling-human",
          },
          null,
          2,
        ),
      },
      {
        label: "shell (temporary override)",
        tag: "env",
        code: `# then run: opencode\nOPENAI_BASE_URL=${baseUrl} \\\nOPENAI_API_KEY=changeling-local \\\nopencode -m changeling/changeling-human`,
      },
    ],
    cURL: [
      {
        label: "single turn",
        tag: "curl",
        code: `curl ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer changeling-local" \\
  -d '{
    "model": "changeling-human",
    "messages": [{ "role": "user", "content": "List the files in src/" }],
    "tools": [{
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Run a shell command",
        "parameters": {
          "type": "object",
          "properties": { "command": { "type": "string" } },
          "required": ["command"]
        }
      }
    }]
  }'`,
      },
    ],
    Python: [
      {
        label: "openai sdk",
        tag: "py",
        code: `from openai import OpenAI

client = OpenAI(base_url="${baseUrl}", api_key="changeling-local")

resp = client.chat.completions.create(
    model="changeling-human",
    messages=[{"role": "user", "content": "What changed in the last commit?"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "git_log",
            "description": "Show recent commits",
            "parameters": {"type": "object", "properties": {"n": {"type": "integer"}}},
        },
    }],
)

msg = resp.choices[0].message
print(msg.content, msg.tool_calls)`,
      },
    ],
    Protocol: [
      {
        label: "response shape",
        tag: "shape",
        code: `POST /v1/chat/completions
  → parks the request, notifies /console
  → returns once you submit a turn

{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "changeling-human",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Running the test suite first.",
      "tool_calls": [{
        "id": "call_…",
        "type": "function",
        "function": { "name": "bash", "arguments": "{\\"command\\":\\"npm test\\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 42, "completion_tokens": 18, "total_tokens": 60 }
}`,
      },
      {
        label: "streaming (stream: true)",
        tag: "sse",
        code: `: changeling-heartbeat          ← every 12s while you think

data: {"choices":[{"delta":{"role":"assistant"}}]}
data: {"choices":[{"delta":{"content":"Running the test suite"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_…","function":{"name":"bash","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"npm test\\"}"}}]}}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
data: [DONE]`,
      },
    ],
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <h2>Connect an agent</h2>
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 9.5,
              letterSpacing: "0.1em",
              padding: "2px 7px",
              borderRadius: 4,
              border: "1px solid rgba(110,231,168,0.3)",
              color: "var(--signal)",
              background: "var(--signal-dim)",
            }}
          >
            OPENAI-COMPATIBLE
          </span>
          <button className="icon-btn ghost" onClick={onClose} style={{ marginLeft: "auto" }}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          <div>
            <div className="section-title">Base URL</div>
            <div className="copy-row">
              <span className="grow">{baseUrl}</span>
              <button className="mini-btn" onClick={() => doCopy(baseUrl, "base")}>
                {copied === "base" ? "copied" : "copy"}
              </button>
            </div>
          </div>

          <div>
            <div className="section-title">API key</div>
            <div className="copy-row">
              <span className="grow">changeling-local</span>
              <button className="mini-btn" onClick={() => doCopy("changeling-local", "key")}>
                {copied === "key" ? "copied" : "copy"}
              </button>
            </div>
            <div className="note" style={{ marginTop: 8 }}>
              Any non-empty key works by default. Set <b>CONSOLE_API_KEYS=key1,key2</b> in{" "}
              <b>.env.local</b> to enforce a whitelist.
            </div>
          </div>

          <div>
            <div className="tabs">
              {TABS.map((t) => (
                <button
                  key={t}
                  className={`tab${tab === t ? " active" : ""}`}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {snippets[tab].map((item) => (
                <div key={item.tag}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        color: "var(--ink-faint)",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {item.label}
                    </span>
                    <button className="mini-btn" onClick={() => doCopy(item.code, item.tag)}>
                      {copied === item.tag ? "copied" : "copy"}
                    </button>
                  </div>
                  <pre className="code">{item.code}</pre>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="section-title">How a turn works</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div className="note">
                <b>1 · Agent asks.</b> The request lands here with the full transcript, its declared{" "}
                tools, and the model name. The HTTP connection stays open.
              </div>
              <div className="note">
                <b>2 · You decide.</b> In the console you write the assistant text, then pick tools
                from the declared list — or type a name the agent never declared — and hand-edit
                every argument as raw JSON. Multiple calls, any order.
              </div>
              <div className="note">
                <b>3 · Agent acts.</b> It receives <b>tool_calls</b> and runs them <i>locally</i> on
                its own machine, with its own permissions. Changeling never executes anything.
              </div>
              <div className="note">
                <b>4 · Results return.</b> Tool output comes back as <b>role: "tool"</b> messages
                and shows up in the transcript. Then the loop repeats.
              </div>
            </div>
          </div>

          <div>
            <div className="section-title">Runtime</div>
            <dl className="kv">
              <dt>turn timeout</dt>
              <dd>15 minutes (CHANGELING_TIMEOUT_MS)</dd>
              <dt>session key</dt>
              <dd>system + first user message hash, or x-changeling-session header</dd>
              <dt>protocol</dt>
              <dd>OpenAI chat completions, streaming + non-streaming</dd>
              <dt>tool execution</dt>
              <dd>client-side, by the agent. Nothing runs on the server.</dd>
            </dl>
          </div>

          <div className="note warn">
            The store is in-memory. Restarting the server drops sessions and aborts in-flight turns.
            Fine for a single operator on one box; swap in Redis before running it as a service.
          </div>
        </div>
      </aside>
    </>
  );
}
