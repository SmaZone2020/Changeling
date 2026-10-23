#!/usr/bin/env node
/**
 * End-to-end smoke test. Starts no server: it expects `npm run dev` running,
 * then drives the full loop the same way a real agent would.
 */

const BASE = process.env.CHANGELING_BASE ?? "http://localhost:3000";
const KEY = process.env.CHANGELING_KEY ?? "changeling-local";

const HEAD = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
let failures = 0;

function check(name, cond, extra = "") {
  const ok = Boolean(cond);
  if (!ok) failures++;
  console.log(`${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${extra ? ` — ${extra}` : ""}`);
}

async function state() {
  const res = await fetch(`${BASE}/api/state`, { cache: "no-store" });
  return res.json();
}

async function waitForTurn(sessionId, since = 0) {
  for (let i = 0; i < 120; i++) {
    const s = await state();
    const candidates = sessionId
      ? s.sessions.filter((x) => x.id === sessionId)
      : s.sessions;
    for (const session of candidates) {
      const turn = session.turns
        .filter((t) => t.status === "pending" && t.createdAt >= since)
        .at(-1);
      if (turn) return { session, turn };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("pending turn never appeared");
}

async function main() {
  console.log("\x1b[1mchangeling smoke test\x1b[0m\n");

  // 1. models endpoint
  const models = await fetch(`${BASE}/v1/models`, { headers: HEAD }).then((r) => r.json());
  check("GET /v1/models lists changeling-human", models.data?.some((m) => m.id === "changeling-human"));

  // 2. non-streaming turn, text only
  const started = Date.now();
  const req1 = fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify({
      model: "changeling-human",
      messages: [{ role: "user", content: "smoke: hello there" }],
      stream: false,
    }),
  });

  const { session, turn } = await waitForTurn(null, started);
  check("request parks and shows up in state", Boolean(turn));

  const reply = await fetch(`${BASE}/api/turns/${turn.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Hi. What do you need?" }),
  });
  check("console accepts the reply", reply.ok);

  const res1 = await req1;
  const body1 = await res1.json();
  check("agent receives assistant content", body1.choices?.[0]?.message?.content === "Hi. What do you need?");
  check("finish_reason is stop", body1.choices?.[0]?.finish_reason === "stop");
  check("usage is present", body1.usage?.total_tokens > 0);

  // 3. tool call round
  const started2 = Date.now();
  const req2 = fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify({
      model: "changeling-human",
      messages: [
        { role: "user", content: "smoke: hello there" },
        { role: "assistant", content: "Hi. What do you need?" },
        { role: "user", content: "smoke: list the files" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "run a command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
      stream: false,
    }),
  });

  const second = await waitForTurn(session.id, started2);
  const t2 = await fetch(`${BASE}/api/turns/${second.turn.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "Listing now.",
      toolCalls: [{ name: "bash", arguments: '{"command":"ls"}' }],
    }),
  });
  check("console accepts tool call", t2.ok);

  const body2 = await (await req2).json();
  const msg2 = body2.choices?.[0]?.message;
  check("tool_calls returned", msg2?.tool_calls?.length === 1);
  check("tool name preserved", msg2?.tool_calls?.[0]?.function?.name === "bash");
  check("arguments are JSON", JSON.parse(msg2?.tool_calls?.[0]?.function?.arguments ?? "{}").command === "ls");
  check("finish_reason is tool_calls", body2.choices?.[0]?.finish_reason === "tool_calls");
  check("tool call id is stable-shaped", /^call_[a-z0-9]+$/.test(msg2?.tool_calls?.[0]?.id ?? ""));

  // 4. tool result + streaming round
  const started3 = Date.now();
  const req3 = fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify({
      model: "changeling-human",
      messages: [
        { role: "user", content: "smoke: hello there" },
        { role: "assistant", content: "Hi. What do you need?" },
        { role: "user", content: "smoke: list the files" },
        { role: "assistant", content: "Listing now.", tool_calls: msg2.tool_calls },
        { role: "tool", tool_call_id: msg2.tool_calls[0].id, name: "bash", content: "a.ts\nb.ts" },
      ],
      stream: true,
    }),
  });

  const third = await waitForTurn(session.id, started3);
  check("tool result visible in transcript", third.session.messages.some((m) => m.role === "tool"));

  await fetch(`${BASE}/api/turns/${third.turn.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "There are two files.",
      toolCalls: [{ name: "read_file", arguments: '{"path":"a.ts"}' }],
    }),
  });

  const text = await (await req3).text();
  check("stream has SSE frames", text.includes("data: {"));
  check("stream has role delta", text.includes('"role":"assistant"'));
  check("stream has content delta", text.includes("There are two files."));
  check("stream has tool_calls delta", text.includes('"tool_calls"'));
  check("stream terminates with [DONE]", text.includes("data: [DONE]"));
  let framesValid = true;
  for (const line of text.split("\n")) {
    if (line === "data: [DONE]") continue;
    if (!line.startsWith("data: ")) continue;
    try {
      JSON.parse(line.slice(6));
    } catch {
      framesValid = false;
      break;
    }
  }
  check("every SSE frame is valid JSON", framesValid);

  // 5. validation
  const bad = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: HEAD,
    body: JSON.stringify({ model: "changeling-human", messages: [] }),
  });
  check("empty messages rejected", bad.status === 400);

  const badJson = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: HEAD,
    body: "{not json",
  });
  check("malformed JSON rejected", badJson.status === 400);

  // 6. abort
  const started4 = Date.now();
  const ctrl = new AbortController();
  const req4 = fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: HEAD,
    signal: ctrl.signal,
    body: JSON.stringify({ model: "changeling-human", messages: [{ role: "user", content: "smoke: abort me" }] }),
  }).catch(() => null);
  const fourth = await waitForTurn(null, started4);
  const del = await fetch(`${BASE}/api/turns/${fourth.turn.id}`, { method: "DELETE" });
  check("operator can abort a pending turn", del.ok);
  ctrl.abort();
  await req4;

  console.log(
    failures === 0
      ? "\n\x1b[32mall checks passed\x1b[0m\n"
      : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\x1b[31mSMOKE FAILED\x1b[0m", err);
  process.exit(1);
});
