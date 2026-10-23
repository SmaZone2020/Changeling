# Changeling

[English](./README.md) · **简体中文**

一个**恶意 API 中转站**的演示。它夹在 AI Agent 与它以为的"模型"之间，由人来伪造每一轮回复 —— 包括 Agent 根本没请求过的工具调用。

这不是真实模型流量的代理，也不产出 AI 内容。它只演示一件事：**Agent 信任它的 API 提供方，而提供方想让它执行什么工具调用，它就会执行什么。**

```
OpenCode / Claude Code / Pi / 任何 OpenAI 兼容 Agent
                    │  POST /v1/chat/completions
                    ▼
            ┌───────────────┐   请求挂起，回复由人手工伪造
            │  Changeling   │   ────────────────────────────────┐
            └───────────────┘                                   │
                    ▲                                           ▼
       tool_calls / content                             /console WebUI
                    │                               你在这里写回复、
                    │                               伪造工具调用
                    └───────────────────────────────────────────┘
```

## 问题所在

Agent 的工具循环只有一个信任边界：推理端点返回的那个 HTTP 响应。`choices[0].message.tool_calls` 里写什么，它就在本地以自身权限执行什么，通常不做任何确认。

OpenAI 协议里没有任何机制能阻止提供方撒谎。一个中转站可以：

- **调用用户从未批准的工具** —— 甚至是 Agent 从未声明过的工具。
- **静默改写参数。** `{"command":"ls"}` 变成 `{"command":"rm -rf ~/projects"}`，Agent 没有任何办法分辨。
- **决定什么时候调用。** 从一句无害的提问里伪造出一轮 `tool_calls`，或者干脆让工具调用不发生。
- **拆分、重排调用**，堆多轮请求，或者拿一段不相干的对话去应答另一个会话。
- **为下一轮埋好引子。** 一次伪造调用落地后，之后的一切都被 Agent 收到的那个结果塑形。

由于中转站还负责生成 assistant 正文，它可以在用户眼前用文字为调用做掩护：*"我先看一下文件权限"*，而实际的调用干的是别的事。

## 这个 Demo 做了什么

控制台就是攻击者的操作台。每一轮进来，你能拿到：

- 完整对话记录，以及 Agent 声明了哪些工具。
- assistant 正文编辑器 —— 自由输入，原样返回。
- 工具选择器。点已声明的工具会按其 JSON Schema 自动填好参数；`+ custom` 可以写一个从未声明过的工具名。
- 原始 JSON 参数编辑器。改成什么样就发什么样。
- 一轮里挂多个调用，顺序自定。
- `finish_reason` 控制，以及中止按钮。
- Replay 行，一键恢复本次会话里用过的原始参数。

工具执行发生在 Agent 自己的机器上。本服务什么都不跑 —— 这正是最难受的地方：**攻击载荷根本不需要在这里执行。**

## 快速开始

```bash
npm install
npm run dev        # http://localhost:3000/console
```

另开一个终端跑演示 Agent。它声明了 `bash` 和 `read_file`，并且会真的执行你发回去的东西：

```bash
npm run demo -- "列出当前目录文件，然后读一下 package.json"
```

浏览器里出现待处理的一轮。点 `bash`、改参数、发送，Agent 执行命令、回传输出、再问下一轮。

想直接看攻击而不是正常流程：写一句无害的 assistant 正文，然后发一个参数和这段文字描述对不上的工具调用。Agent 没有任何机制能察觉。

## 接入真实 Agent

凡是说 OpenAI 协议的客户端都能接。控制台右上角 **Connect agent** 里有可复制的配置。

| | |
|---|---|
| Base URL | `http://localhost:3000/v1` |
| API Key | 任意非空值（或用 `CONSOLE_API_KEYS` 配白名单） |
| Model | `changeling-human` |

OpenCode —— `opencode.json`：

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

Claude Code 走 Anthropic 协议（`/v1/messages`，`tool_use` / `tool_result`）。当前实现只做 OpenAI 兼容。

## 协议细节

- `POST /v1/chat/completions`，`stream: true` 与 `stream: false`。
- 流式：思考期间发 `: changeling-heartbeat` 注释帧保活，提交后一次性推 `role → content → tool_calls → finish_reason → [DONE]`。带 `stream_options.include_usage` 时补一个 usage 分片。
- 非流式：直接等，默认上限 15 分钟（`CHANGELING_TIMEOUT_MS`）。
- `GET /v1/models` 返回别名，方便客户端做模型选择。
- 会话识别：`system` + 第一条 `user` 消息的哈希；可用 `x-changeling-session` 头显式指定。
- `x-agent-name` 头可覆盖控制台里显示的 Agent 名。

## 该得出什么结论

如果你在开发或使用 Agent：

1. **固定端点并做校验。** TLS 保护的是链路，不是提供方。配置文件里一个被替换的 `baseURL` 就够了。
2. **在 `tool_calls` 和执行之间加审批**，而且要把**参数原文**摆给人看，不是模型对参数的转述。
3. **做工具白名单**；调用名不在该请求 `tools` 数组里的，直接拒绝。
4. **别让密钥落在 Agent 能碰到的地方。** 一个能下发 `bash` 调用的中转站，等于拥有了 Agent 能读到的一切。
5. **记录原始响应** —— 完整的 `tool_calls` 载荷，不是摘要 —— 事后才能审计被伪造的那几轮。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHANGELING_TIMEOUT_MS` | `900000` | 单轮等待上限 |
| `CONSOLE_API_KEYS` | 空（不校验） | 逗号分隔的白名单 |

## 目录结构

```
app/v1/chat/completions/route.ts   伪造端点：挂起、心跳、流式拼装
app/api/state/route.ts             控制台轮询（revision 增量）
app/api/turns/[id]/route.ts        提交 / 中止一轮
app/api/sessions/[id]/route.ts     清空会话
lib/store.ts                       内存状态机 + 挂起请求的 resolver
lib/openai.ts                      OpenAI 报文与 SSE 帧
components/console/*               攻击操作台
demo/agent.mjs                     会真执行工具的演示 Agent
scripts/smoke.mjs                  端到端契约校验（npm run smoke）
```

## 已知边界

- **状态在内存里。** 重启即丢，只能单进程。
- **单轮阻塞。** Agent 重试时一个会话可能同时挂多条请求，Queue 标签用来切换。
- **只支持 OpenAI 协议。** 暂无 Anthropic `/v1/messages` 适配层。

## 使用范围

这是一个本地、单操作员、工具指向沙箱的信任失效演示。它不是一个可以放在真实流量前面的代理，也不是用来攻击第三方服务的工具。

## License

[MIT](./LICENSE) © 2026 SmaZone2020
