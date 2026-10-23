# Relay

**English** · [简体中文](./README.zh-CN.md)

An OpenAI-compatible endpoint that **never produces AI content**. Every agent turn parks here and waits for a human: you write the assistant message, you pick which tool to call, and you hand-edit every argument. The agent executes those tools on its own machine, sends the results back, and the loop repeats.

```
OpenCode / Claude Code / Pi / any OpenAI-compatible agent
                    │  POST /v1/chat/completions
                    ▼
            ┌───────────────┐   request parked (HTTP held open, 12s heartbeat)
            │  Relay server │   ────────────────────────────────────┐
            └───────────────┘                                      │
                    ▲                                              ▼
        tool_calls / content                              /console WebUI
                    │                                 you write the reply,
                    │                                 pick tools, edit args
                    └──────────────────────────────────────────────┘
```

## Why

A normal AI gateway hides the model and treats tool calls as a side effect. This inverts it: **tool calls are the first-class thing, and the human is the model.** Every step is visible, every argument is editable, any call can be refused, and you can deliberately feed the agent broken input to watch it recover. Useful for debugging tool use, reviewing what an agent actually intends to do, or just hand-driving a long task.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000/console
```

Then, in a second terminal, run the demo agent — it declares `bash` and `read_file` and genuinely executes whatever you send back:

```bash
npm run demo -- "list the files here, then read package.json"
```

A turn appears in the browser. Click a tool name, the arguments template is filled in from the tool's JSON Schema, edit it, hit send. The demo agent runs the command, returns the result, and asks again.

## Connecting a real agent

The **Connect agent** button in the console has ready-to-copy config. The essentials:

| | |
|---|---|
| Base URL | `http://localhost:3000/v1` |
| API key | any non-empty value (or a whitelist via `CONSOLE_API_KEYS`) |
| Model | `relay-human` |

### OpenCode

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "relay": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Relay (human operator)",
      "options": { "baseURL": "http://localhost:3000/v1", "apiKey": "relay-local" },
      "models": { "relay-human": { "name": "Human operator" } }
    }
  },
  "model": "relay/relay-human"
}
```

### Pi

Any client that speaks OpenAI chat completions works:

```bash
export OPENAI_BASE_URL=http://localhost:3000/v1
export OPENAI_API_KEY=relay-local
```

### Claude Code

Claude Code speaks the Anthropic protocol (`/v1/messages`, `tool_use` / `tool_result`). This build is OpenAI-only — see Roadmap.

## What you control per turn

- **Assistant content** — returned to the agent verbatim; may be empty.
- **Tool name** — pick from the tools the agent declared, or hit `+ custom` and write a name it never declared.
- **Every argument** — a raw JSON editor with live validation. Invalid JSON cannot be sent.
- **Call count and order** — queue multiple tool calls; `index` follows the order you added them.
- **`finish_reason`** — inferred from whether tool calls exist, or forced to `stop` / `length`.
- **Replay** — tools used earlier in this session are listed in a Replay row; one click restores the exact arguments.
- **Abort** — kills the turn immediately; the agent receives an error and stops waiting.

Tool execution always happens on the agent side. This server runs no commands and touches no filesystem.

## Protocol notes

- `POST /v1/chat/completions`, both `stream: true` and `stream: false`.
- Streaming: `: relay-heartbeat` comment frames while you think, then one burst of `role → content → tool_calls → finish_reason → [DONE]`. `stream_options.include_usage` adds a usage frame.
- Non-streaming: plain wait, up to 15 minutes (`RELAY_TIMEOUT_MS`).
- `GET /v1/models` returns three aliases so clients' model pickers work.
- Session identity: hash of `system` + first `user` message; override with the `x-relay-session` header.
- `x-agent-name` header overrides the agent label (otherwise guessed from User-Agent).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TIMEOUT_MS` | `900000` | Max wait per turn |
| `CONSOLE_API_KEYS` | empty (no auth) | Comma-separated allowlist |

## Layout

```
app/v1/chat/completions/route.ts   protocol surface: park, heartbeat, stream assembly
app/api/state/route.ts             console polling (revision-diffed)
app/api/turns/[id]/route.ts        submit / abort a turn
app/api/sessions/[id]/route.ts     clear a session
lib/store.ts                       in-memory state machine + parked-request resolvers
lib/openai.ts                      OpenAI payloads and SSE frames
components/console/*               the WebUI
demo/agent.mjs                     demo agent that really executes tools
scripts/smoke.mjs                  end-to-end contract checks (npm run smoke)
```

## Known limits

- **State is in memory.** Restarts drop sessions; single process only. For anything long-lived, move to Redis plus distributed waits (or switch parking to a poll-based async job).
- **One turn blocks.** A session can hold several parked requests if the agent retries; the Queue tabs let you switch between them, but normally there is exactly one.
- **OpenAI protocol only.** Claude Code needs an Anthropic `/v1/messages` adapter.
- **Light auth.** Optional allowlist, no per-user isolation. Do not expose this to the public internet as-is.

## Roadmap

- [ ] Anthropic `/v1/messages` adapter (`tool_use` / `tool_result`)
- [ ] Redis-backed store with cross-process waits
- [ ] Per-tool auto-approve policies (still editable)
- [ ] Turn history export as a replayable JSON transcript
- [ ] Multi-operator claim / handoff

## License

[MIT](./LICENSE) © 2026 SmaZone2020
