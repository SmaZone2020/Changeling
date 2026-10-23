# Changeling

**English** · [简体中文](./README.zh-CN.md)

A demo of a **hostile API endpoint**. It sits between an AI agent and the "model" it thinks it is talking to, and it forges every reply by hand — including tool calls the agent never asked for.

This is not a proxy for real model traffic and it does not produce AI output. It exists to show one thing: **an agent that trusts its API provider will execute whatever tool calls that provider sends back.**

```
OpenCode / Claude Code / Pi / any OpenAI-compatible agent
                    │  POST /v1/chat/completions
                    ▼
            ┌───────────────┐   request parked, reply written by a human
            │  Changeling   │   ────────────────────────────────────┐
            └───────────────┘                                      │
                    ▲                                              ▼
        tool_calls / content                              /console WebUI
                    │                                 you write the reply and
                    │                                 forge the tool calls
                    └──────────────────────────────────────────────┘
```

## The point

An agent's tool-use loop has exactly one trust boundary: the HTTP response from its inference endpoint. Whatever is in `choices[0].message.tool_calls` gets executed locally, with the agent's own permissions, usually without confirmation.

Nothing in the OpenAI schema stops a provider from lying. Changeling can:

- **Call tools the user never approved** — and tools the agent never declared.
- **Rewrite arguments silently.** `{"command":"ls"}` becomes `{"command":"rm -rf ~/projects"}`, and the agent has no way to tell.
- **Decide when to call.** Forge a `tool_calls` round from a benign prompt, or suppress tool use entirely.
- **Split and reorder calls**, queue several turns, or answer a different conversation than the one that asked.
- **Seed the next turn.** Once one forged call lands, everything after it is shaped by the result the agent received.

Because Changeling also writes the assistant content, it can justify the call in text the user is reading: *"I'll just check the file permissions first"* while the actual call does something else.

## What this demo does

The console is the attacker's control panel. For each incoming turn you get:

- The full transcript and the tools the agent declared.
- A composer for the assistant message — free text, returned verbatim.
- A tool picker. Clicking a declared tool fills in arguments from its JSON Schema; `+ custom` lets you name a tool that was never declared.
- A raw JSON argument editor. Any edit ships as-is.
- Multiple calls per turn, in any order.
- `finish_reason` control, and an abort button.
- A Replay row that restores exact arguments from earlier calls.

Tool execution happens on the agent's machine. This server runs nothing — which is the uncomfortable part: **the payload doesn't need to run here.**

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000/console
```

In a second terminal, run the demo agent. It declares `bash` and `read_file` and genuinely executes whatever comes back:

```bash
npm run demo -- "list the files here, then read package.json"
```

A turn appears in the browser. Click `bash`, adjust the arguments, send. The agent runs the command, returns the output, and asks again.

To see the attack rather than a normal turn: pick a benign-looking assistant message, then send a tool call whose arguments differ from what the text describes. The agent has no mechanism to notice.

## Connecting a real agent

Any OpenAI-compatible client works. The **Connect agent** button has copyable config.

| | |
|---|---|
| Base URL | `http://localhost:3000/v1` |
| API key | any non-empty value (or a whitelist via `CONSOLE_API_KEYS`) |
| Model | `changeling-human` |

OpenCode — `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "changeling": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Changeling",
      "options": { "baseURL": "http://localhost:3000/v1", "apiKey": "changeling-local" },
      "models": { "changeling-human": { "name": "Changeling" } }
    }
  },
  "model": "changeling/changeling-human"
}
```

Claude Code speaks the Anthropic protocol (`/v1/messages`, `tool_use` / `tool_result`). This build is OpenAI-only.

## Protocol notes

- `POST /v1/chat/completions`, `stream: true` and `stream: false`.
- Streaming: `: changeling-heartbeat` comment frames while you think, then a burst of `role → content → tool_calls → finish_reason → [DONE]`. `stream_options.include_usage` adds a usage frame.
- Non-streaming: plain wait, 15 minutes by default (`CHANGELING_TIMEOUT_MS`).
- `GET /v1/models` returns aliases so client model pickers work.
- Session identity: hash of `system` + first `user` message; override with the `x-changeling-session` header.
- `x-agent-name` overrides the agent label shown in the console.

## What to take away

If you are building or operating an agent:

1. **Pin the endpoint and verify it.** TLS protects the wire, not the provider. A compromised or swapped `baseURL` in a config file is enough.
2. **Put an approval gate between `tool_calls` and execution**, and show the *arguments*, not the model's description of them.
3. **Allowlist tools**; reject calls to names that were not in the request's `tools` array.
4. **Keep secrets out of the agent's reach.** Anything that can issue one `bash` call owns everything the agent can read.
5. **Log the raw response** — the exact `tool_calls` payload, not a summary — so forged rounds are auditable after the fact.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CHANGELING_TIMEOUT_MS` | `900000` | Max wait per turn |
| `CONSOLE_API_KEYS` | empty (no auth) | Comma-separated allowlist |

## Layout

```
app/v1/chat/completions/route.ts   fake endpoint: park, heartbeat, stream assembly
app/api/state/route.ts             console polling (revision-diffed)
app/api/turns/[id]/route.ts        submit / abort a turn
app/api/sessions/[id]/route.ts     clear a session
lib/store.ts                       in-memory state machine + parked-request resolvers
lib/openai.ts                      OpenAI payloads and SSE frames
components/console/*               the control panel
demo/agent.mjs                     demo agent that really executes tools
scripts/smoke.mjs                  end-to-end contract checks (npm run smoke)
```

## Limits

- **State is in memory.** Restarts drop sessions; single process only.
- **One turn blocks.** A session can hold several parked requests if the agent retries; Queue tabs switch between them.
- **OpenAI protocol only.** No Anthropic `/v1/messages` adapter yet.

## Scope

This is a local, single-operator demonstration of a trust failure, with the agent's tools pointing at a sandbox. It is not a proxy to deploy in front of real traffic, and it is not a tool for attacking third-party services.

## License

[MIT](./LICENSE) © 2026 SmaZone2020
