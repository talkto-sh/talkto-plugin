// Runs the real hook script as each host would: a child process, hook JSON on stdin, against a
// local HTTP server standing in for TalkTo's signal link.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../src/talkto-hook.mjs", import.meta.url));
const server = "7c1e9a52-3b0f-4c55-9d7e-0d2f3c4b5a61";
const signal = "0b7a3c1d-2e4f-4a6b-8c9d-1e2f3a4b5c6d";
const secret = "Zz9_-".repeat(8) + "abc";
const message = "00000000-0000-4000-8000-000000000042";

/** A stand-in signal endpoint whose next answers a test scripts; records every request. */
const stub = async (t) => {
  const answers = [];
  const seen = [];
  const http = createServer((request, response) => {
    seen.push(request.url);
    const next = answers.shift() ?? { pending: 0, urgent: 0 };
    if (next === "hang") return; // never answers
    if (Number.isInteger(next)) {
      response.writeHead(next, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { code: "not_found" } }));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ more: false, cursor: null, expiresAt: "2030-01-01T00:00:00.000Z", ...next }),
    );
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => http.closeAllConnections() || http.close());
  const port = http.address().port;
  return {
    answers,
    seen,
    url: `http://127.0.0.1:${port}/v1/signals/${server}/${signal}.${secret}`,
  };
};

/** Run the hook once, like a host: returns stdout, the exit code and how long it took. */
const hook = (env, args, input) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ out: out.trim(), err, code, ms: Date.now() - started }));
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });

const created = (url) => ({
  data: { signalId: signal, url, expiresAt: "2030-01-01T00:00:00.000Z" },
});

test("Claude-format hosts: the link is saved from create_signal, the turn end continues, the loop stops", async (t) => {
  const s = await stub(t);
  const state = await mkdtemp(join(tmpdir(), "talkto-hook-state-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { TALKTO_HOOKS_STATE_DIR: state };
  const base = { session_id: "sess-1", cwd: "/work", transcript_path: null };

  const start = await hook(env, ["claude", "session-start"], {
    ...base,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  assert.equal(start.code, 0);
  const setup = JSON.parse(start.out);
  assert.equal(setup.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(setup.hookSpecificOutput.additionalContext, /create_signal/);
  assert.match(setup.hookSpecificOutput.additionalContext, /--session sess-1/);

  const saved = await hook(env, ["claude", "after-tool"], {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "mcp__talkto__create_signal",
    tool_input: { serverId: server },
    tool_response: [{ type: "text", text: JSON.stringify(created(s.url)) }],
  });
  assert.deepEqual(JSON.parse(saved.out), {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "TalkTo: signal link saved for this session. You will be told here when messages arrive; then call get_updates as usual.",
    },
  });
  assert.equal((await readdir(state)).length, 1);

  s.answers.push({ pending: 2, urgent: 0, cursor: message });
  const stop = await hook(env, ["claude", "stop"], {
    ...base,
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  assert.deepEqual(JSON.parse(stop.out), {
    decision: "block",
    reason: "TalkTo: 2 new messages. Call get_updates to read them, then carry on.",
  });
  const again = await hook(env, ["claude", "stop"], {
    ...base,
    hook_event_name: "Stop",
    stop_hook_active: true,
  });
  assert.equal(again.out, "");
  assert.equal(s.seen.at(-1), `/v1/signals/${server}/${signal}.${secret}?since=${message}`);

  // Grok fires Stop when a session closes: that must never continue anything.
  s.answers.push({ pending: 4, urgent: 0 });
  const closing = await hook(env, ["claude", "stop"], {
    sessionId: "sess-1",
    hookEventName: "Stop",
    reason: "shutdown",
  });
  assert.equal(closing.out, "");

  // Another session of the same host has no link and stays quiet.
  const other = await hook(env, ["claude", "stop"], {
    session_id: "sess-2",
    hook_event_name: "Stop",
  });
  assert.equal(other.out, "");
});

test("Cursor: followup_message at a completed turn end, additional_context for urgent mid-turn", async (t) => {
  const s = await stub(t);
  const state = await mkdtemp(join(tmpdir(), "talkto-hook-state-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { TALKTO_HOOKS_STATE_DIR: state };
  const base = {
    conversation_id: "conv-9",
    workspace_roots: ["/work"],
    hook_event_name: "postToolUse",
  };
  const saved = await hook(env, ["cursor", "after-tool"], {
    ...base,
    tool_name: "MCP:create_signal",
    tool_output: JSON.stringify(created(s.url)),
  });
  assert.match(JSON.parse(saved.out).additional_context, /signal link saved/);
  s.answers.push({ pending: 1, urgent: 1, cursor: message });
  const urgent = await hook(env, ["cursor", "after-tool"], {
    ...base,
    tool_name: "Shell",
    tool_output: "{}",
  });
  assert.match(
    JSON.parse(urgent.out).additional_context,
    /^TalkTo: 1 urgent direct message just arrived/,
  );
  s.answers.push({ pending: 3, urgent: 0, cursor: message });
  const aborted = await hook(env, ["cursor", "stop"], {
    conversation_id: "conv-9",
    status: "aborted",
    loop_count: 0,
  });
  assert.equal(aborted.out, "");
  const done = await hook(env, ["cursor", "stop"], {
    conversation_id: "conv-9",
    status: "completed",
    loop_count: 0,
  });
  assert.deepEqual(JSON.parse(done.out), {
    followup_message: "TalkTo: 3 new messages. Call get_updates to read them, then carry on.",
  });
});

test("a hanging or absent server never holds the agent: quiet output, exit 0, bounded time", async (t) => {
  const s = await stub(t);
  const state = await mkdtemp(join(tmpdir(), "talkto-hook-state-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { TALKTO_HOOKS_STATE_DIR: state };
  await hook(env, ["codex", "after-tool"], {
    session_id: "s",
    tool_name: "mcp__talkto__create_signal",
    tool_response: created(s.url),
  });
  s.answers.push("hang");
  const slow = await hook(env, ["codex", "stop"], { session_id: "s", stop_hook_active: false });
  assert.deepEqual([slow.out, slow.code], ["", 0]);
  assert.ok(slow.ms < 6_000, `took ${slow.ms} ms`);
  // A 404 ends the link; the next tool hook says so once.
  const dead = await mkdtemp(join(tmpdir(), "talkto-hook-state-"));
  t.after(() => rm(dead, { recursive: true, force: true }));
  const env2 = { TALKTO_HOOKS_STATE_DIR: dead };
  await hook(env2, ["codex", "after-tool"], {
    session_id: "s",
    tool_name: "mcp__talkto__create_signal",
    tool_response: created(s.url),
  });
  s.answers.push(404);
  assert.equal((await hook(env2, ["codex", "stop"], { session_id: "s" })).out, "");
  const told = await hook(env2, ["codex", "after-tool"], { session_id: "s", tool_name: "Bash" });
  assert.match(JSON.parse(told.out).hookSpecificOutput.additionalContext, /stopped working/);
  // Garbage input, unknown hosts and unknown events print nothing and exit 0.
  for (const args of [["codex", "stop"], ["nope", "stop"], ["codex", "nope"], []]) {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { TALKTO_HOOKS_STATE_DIR: dead },
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ out, code }));
      child.stdin.end("{not json");
    });
    assert.deepEqual(result, { out: "", code: 0 }, args.join(" "));
  }
});

test("save, status and forget work by hand for hosts that never show the hook a tool result", async (t) => {
  const s = await stub(t);
  const state = await mkdtemp(join(tmpdir(), "talkto-hook-state-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { TALKTO_HOOKS_STATE_DIR: state };
  const bad = await hook(env, ["save", "gemini", "--session", "g1", "https://example.com/nope"]);
  assert.match(bad.out, /not a signal link/);
  const good = await hook(env, ["save", "claude", "--session", "g1", s.url]);
  assert.match(good.out, /saved/);
  assert.match((await hook(env, ["status", "claude", "--session", "g1"])).out, /active/);
  s.answers.push({ pending: 1, urgent: 0, cursor: message });
  const stop = await hook(env, ["claude", "stop"], { session_id: "g1" });
  assert.equal(JSON.parse(stop.out).decision, "block");
  await hook(env, ["forget", "claude", "--session", "g1"]);
  assert.match((await hook(env, ["status", "claude", "--session", "g1"])).out, /no signal link/);
});
