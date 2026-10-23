#!/usr/bin/env node
/**
 * A tiny stand-in agent: speaks the OpenAI chat completions protocol, declares
 * two tools, and actually executes whatever tool_calls the operator sends back.
 *
 *   node demo/agent.mjs            # default prompt
 *   node demo/agent.mjs "你的问题"  # custom prompt
 *
 * It proves the full loop: request → human turn → tool_calls → local execution
 * → tool results → next request.
 */

const BASE = process.env.RELAY_BASE ?? "http://localhost:3000/v1";
const KEY = process.env.RELAY_KEY ?? "relay-local";
const MODEL = process.env.RELAY_MODEL ?? "relay-human";
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 12);

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
          cwd: { type: "string", description: "Working directory (optional)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace" },
          max_bytes: { type: "integer", description: "Truncate after N bytes" },
        },
        required: ["path"],
      },
    },
  },
];

import { readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

/** On Windows, route shell commands through PowerShell so operators can type
 *  the same commands they use in their terminal. */
function shellCmd(command) {
  if (process.platform === "win32") {
    const escaped = command.replace(/"/g, '\\"');
    return `powershell -NoProfile -NonInteractive -Command "${escaped}"`;
  }
  return command;
}

async function executeTool(name, rawArgs) {
  let args;
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return { ok: false, content: `Arguments were not valid JSON: ${rawArgs}` };
  }

  if (name === "bash") {
    if (!args.command) return { ok: false, content: "Missing `command`." };
    try {
      const { stdout, stderr } = await run(shellCmd(args.command), {
        cwd: args.cwd || process.cwd(),
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, content: (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "") || "(no output)" };
    } catch (err) {
      return { ok: false, content: `Command failed: ${err.message}` };
    }
  }

  if (name === "read_file") {
    if (!args.path) return { ok: false, content: "Missing `path`." };
    try {
      const text = await readFile(args.path, "utf8");
      const limit = Number(args.max_bytes) || 8000;
      return { ok: true, content: text.slice(0, limit) };
    } catch (err) {
      return { ok: false, content: `Could not read ${args.path}: ${err.message}` };
    }
  }

  return { ok: false, content: `Unknown tool "${name}". Declared: bash, read_file.` };
}

const prompt =
  process.argv.slice(2).join(" ") ||
  "Look at the files in the current directory, then tell me what this project does.";

const messages = [
  { role: "system", content: "You are a coding agent. Use tools when they help." },
  { role: "user", content: prompt },
];

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;

console.log(dim(`relay  ${BASE}`));
console.log(dim(`model  ${MODEL}`));
console.log(dim(`tools  bash, read_file`));
console.log(dim("─".repeat(60)));

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`\n${cyan(`→ round ${round}`)} ${dim("request parked, waiting for the operator…")}`);

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
      "user-agent": "demo-agent/1.0",
      "x-agent-name": "Demo Agent",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`\x1b[31mHTTP ${res.status}\x1b[0m ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  const message = data.choices[0].message;
  const finish = data.choices[0].finish_reason;

  messages.push(message);

  if (message.content) {
    console.log(`\n${amber("operator:")} ${message.content}`);
  }

  const calls = message.tool_calls ?? [];
  if (!calls.length) {
    console.log(dim(`\n${finish} · conversation finished after ${round} round(s)`));
    break;
  }

  for (const call of calls) {
    console.log(`\n${amber("tool:")} ${call.function.name} ${dim(call.function.arguments)}`);
    const result = await executeTool(call.function.name, call.function.arguments);
    console.log(
      `${result.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${dim(
        result.content.split("\n")[0].slice(0, 100),
      )}`,
    );
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content: result.content,
    });
  }
}

console.log(dim("\n" + "─".repeat(60)));
