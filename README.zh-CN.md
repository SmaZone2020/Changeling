# Relay

[English](./README.md) · **简体中文**

一个**不生产任何 AI 内容**的 OpenAI 兼容端点。Agent 每发一轮请求都会停在这里等你：assistant 那一轮由你写，调哪个工具由你选，每个参数由你手改。Agent 拿到 `tool_calls` 后在自己的机器上执行，把结果发回来，循环继续。

```
OpenCode / Claude Code / Pi / 任何 OpenAI 兼容 Agent
                    │  POST /v1/chat/completions
                    ▼
            ┌───────────────┐   请求挂起（HTTP 保持打开，12s 心跳）
            │  Relay 服务   │   ────────────────────────────────┐
            └───────────────┘                                   │
                    ▲                                           ▼
       tool_calls / content                             /console WebUI
                    │                                    你在这里写回复、
                    │                                    选工具、改参数
                    └───────────────────────────────────────────┘
```

## 为什么这么做

常规 AI 网关把模型挡在后面，工具调用只是模型的副产品。这里把顺序倒过来：**工具调用是第一公民，人就是模型。** 每一步都看得见，每个参数都能改，任何调用都能拒绝，还能故意喂错误输入看它怎么自救。适合调试 Agent 的工具行为、做执行前审查，或者单纯手动推一段长任务。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:3000/console
```

再开一个终端跑演示 Agent —— 它声明了 `bash` 和 `read_file`，并且会真的执行你发回去的调用：

```bash
npm run demo -- "列出当前目录文件，然后读一下 package.json"
```

浏览器里会出现待处理的一轮：点工具名 → 按该工具的 JSON Schema 自动带出参数模板 → 改参数 → 发送。演示 Agent 执行命令，把结果送回来，再问下一轮。

## 接入真实 Agent

控制台右上角 **Connect agent** 里有现成可复制的配置。核心三项：

| | |
|---|---|
| Base URL | `http://localhost:3000/v1` |
| API Key | 任意非空值（或用 `CONSOLE_API_KEYS` 配白名单） |
| Model | `relay-human` |

### OpenCode

`opencode.json`：

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

凡是说 OpenAI chat completions 的客户端都能接：

```bash
export OPENAI_BASE_URL=http://localhost:3000/v1
export OPENAI_API_KEY=relay-local
```

### Claude Code

Claude Code 走 Anthropic 协议（`/v1/messages`，`tool_use` / `tool_result`）。当前实现只做 OpenAI 兼容，见 Roadmap。

## 一轮里你能控制什么

- **assistant 正文** —— 原样回给 Agent，可为空。
- **工具名** —— 从 Agent 声明的列表里点选；也可以点 `+ custom`，手写一个它根本没声明过的工具名。
- **每一个参数** —— 原始 JSON 编辑器，带实时校验，不合法不让发。
- **调用数量与顺序** —— 一次可以挂多个 tool call，`index` 按添加顺序生成。
- **`finish_reason`** —— 默认按有没有 tool call 自动推断，也可强制为 `stop` / `length`。
- **Replay** —— 本会话里用过的工具列在 Replay 行，一键恢复原参数，不用重敲。
- **Abort** —— 立刻掐断这一轮，Agent 收到错误并结束等待。

工具执行永远发生在 Agent 那一侧。本服务不执行任何命令、不读写任何文件。

## 协议细节

- `POST /v1/chat/completions`，`stream: true` 与 `stream: false` 都支持。
- 流式：思考期间发 `: relay-heartbeat` 注释帧保活，你提交后一次性推 `role → content → tool_calls → finish_reason → [DONE]`。带 `stream_options.include_usage` 时补一个 usage 分片。
- 非流式：直接等，上限 15 分钟（`RELAY_TIMEOUT_MS`）。
- `GET /v1/models` 返回三个别名，方便客户端做模型选择。
- 会话识别：`system` + 第一条 `user` 消息的哈希；可用 `x-relay-session` 头显式指定。
- `x-agent-name` 头可覆盖 Agent 显示名，否则从 User-Agent 推断。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RELAY_TIMEOUT_MS` | `900000` | 单轮等待上限 |
| `CONSOLE_API_KEYS` | 空（不校验） | 逗号分隔的白名单 |

## 目录结构

```
app/v1/chat/completions/route.ts   协议外观：挂起、心跳、流式拼装
app/api/state/route.ts             控制台轮询（revision 增量）
app/api/turns/[id]/route.ts        提交 / 中止一轮
app/api/sessions/[id]/route.ts     清空会话
lib/store.ts                       内存状态机 + 挂起请求的 resolver
lib/openai.ts                      OpenAI 报文与 SSE 帧
components/console/*               WebUI
demo/agent.mjs                     会真执行工具的演示 Agent
scripts/smoke.mjs                  端到端契约校验（npm run smoke）
```

## 已知边界

- **状态在内存里。** 重启即丢，且只能单进程。要长期跑就换 Redis + 跨进程等待（或把挂起改成轮询式异步任务）。
- **单轮阻塞。** Agent 重试时一个会话可能同时挂多条请求，Queue 标签可以切换，但正常情况只有一条。
- **只支持 OpenAI 协议。** Claude Code 需要 Anthropic `/v1/messages` 适配层。
- **鉴权很轻。** 只有可选白名单，没有多用户隔离。不要直接暴露到公网。

## Roadmap

- [ ] Anthropic `/v1/messages` 适配（`tool_use` / `tool_result`）
- [ ] Redis 存储 + 跨进程等待
- [ ] 按工具配置自动放行策略（仍可编辑）
- [ ] 把一轮历史导出成可重放的 JSON transcript
- [ ] 多操作员认领 / 交接

## License

[MIT](./LICENSE) © 2026 SmaZone2020
