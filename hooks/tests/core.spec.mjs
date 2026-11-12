// The host-independent rules: when to check, what to say, and what is never said.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkRequest,
  defaults,
  fileStore,
  fresh,
  handle,
  linkFrom,
  notices,
  stateKey,
} from "../src/core.mjs";

const server = "7c1e9a52-3b0f-4c55-9d7e-0d2f3c4b5a61";
const signal = "0b7a3c1d-2e4f-4a6b-8c9d-1e2f3a4b5c6d";
const secret = "A".repeat(42) + "B";
const url = `https://talkto.sh/v1/signals/${server}/${signal}.${secret}`;
const message = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const later = new Date(Date.UTC(2030, 0, 1)).toISOString();

/** A fake world: one state slot, a clock, and a link whose answers the test scripts. */
const world = (answers = []) => {
  let state = null;
  let clock = 1_000_000;
  const requests = [];
  const authorizations = [];
  const deps = {
    load: async () => (state === null ? null : structuredClone(state)),
    save: async (value) => {
      state = structuredClone(value);
    },
    forget: async () => {
      state = null;
    },
    fetch: async (target, init) => {
      requests.push(target);
      authorizations.push(init.headers.authorization);
      const next = answers.shift() ?? { pending: 0, urgent: 0 };
      if (next instanceof Error) throw next;
      if (Number.isInteger(next))
        return new Response(JSON.stringify({ error: { code: "x" } }), {
          status: next,
          headers: next === 429 ? { "retry-after": "30" } : {},
        });
      return Response.json({ more: false, cursor: null, expiresAt: later, ...next });
    },
    now: () => clock,
    settings: defaults,
    saveCommand: "node hook save",
    quietStart: false,
  };
  return {
    deps,
    requests,
    authorizations,
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    tick: (ms) => {
      clock += ms;
    },
  };
};
const hook = (kind, fields = {}) => ({
  kind,
  sessionId: "s1",
  cwd: "/work",
  toolName: null,
  toolResponse: null,
  stopActive: false,
  skip: false,
  ...fields,
});
const linked = (w) => {
  w.state = fresh(url, signal, later);
};

test("a create_signal result is captured from any form a host gives it; other tools are ignored", async () => {
  const structured = { data: { url, expiresAt: later, signalId: signal } };
  const results = [
    structured,
    JSON.stringify(structured),
    [{ type: "text", text: JSON.stringify(structured) }],
    JSON.stringify([{ type: "text", text: JSON.stringify(structured) }]),
    { result: { structuredContent: structured } },
  ];
  for (const result of results)
    assert.deepEqual(linkFrom("mcp__talkto__create_signal", result), {
      url,
      signalId: signal,
      expiresAt: later,
    });
  for (const name of ["MCP:create_signal", "talkto/create_signal", "create_signal"])
    assert.equal(linkFrom(name, structured)?.url, url);
  // A link pasted into a message read through get_updates is never trusted.
  assert.equal(linkFrom("mcp__talkto__get_updates", structured), null);
  assert.equal(linkFrom(null, structured), null);
  // Plain HTTP only on loopback.
  assert.equal(linkFrom("create_signal", { url: url.replace("https://", "http://") }), null);
  const local = `http://127.0.0.1:8787/v1/signals/${server}/${signal}.${secret}`;
  assert.equal(linkFrom("create_signal", { url: local })?.url, local);

  const w = world();
  const reply = await handle(
    hook("afterTool", { toolName: "mcp__talkto__create_signal", toolResponse: structured }),
    w.deps,
  );
  assert.equal(reply.context, notices.saved());
  assert.equal(w.state.url, url);
  assert.equal(w.requests.length, 0);
  const removed = await handle(
    hook("afterTool", { toolName: "mcp__talkto__revoke_signal" }),
    w.deps,
  );
  assert.equal(removed.context, notices.forgotten());
  assert.equal(w.state, null);
});

test("without a link the session start says how to join, once; nothing else speaks", async () => {
  const w = world();
  const start = await handle(hook("sessionStart"), w.deps);
  assert.match(start.context, /create_signal/);
  assert.match(start.context, /node hook save/);
  for (const kind of ["promptSubmit", "afterTool", "stop"])
    assert.deepEqual(await handle(hook(kind), w.deps), {});
  assert.deepEqual(await handle(hook("sessionStart"), { ...w.deps, quietStart: true }), {});
  assert.equal(w.requests.length, 0);
});

test("turn end continues once per batch; the cursor moves so the same messages never repeat", async () => {
  const w = world([
    { pending: 2, urgent: 1, cursor: message(2) },
    { pending: 0, urgent: 0, cursor: message(2) },
  ]);
  linked(w);
  const first = await handle(hook("stop"), w.deps);
  assert.equal(
    first.continueWith,
    "TalkTo: 2 new messages, 1 urgent. Call get_updates to read them, then carry on.",
  );
  assert.equal(w.state.cursor, message(2));
  const second = await handle(hook("stop", { stopActive: true }), w.deps);
  assert.deepEqual(second, {});
  assert.ok(w.requests[1].endsWith(`since=${message(2)}`));
  assert.ok(!w.requests[0].includes("since="));
});

test("a check sends the link's secret in the Authorization header, never in the URL", async () => {
  const w = world([
    { pending: 1, urgent: 0, cursor: message(1) },
    { pending: 0, urgent: 0 },
  ]);
  linked(w);
  await handle(hook("stop"), w.deps);
  await handle(hook("stop", { stopActive: false }), w.deps);
  assert.equal(w.requests[0], `https://talkto.sh/v1/signals/${server}/${signal}`);
  assert.equal(
    w.requests[1],
    `https://talkto.sh/v1/signals/${server}/${signal}?since=${message(1)}`,
  );
  for (const request of w.requests) assert.ok(!request.includes(secret), request);
  assert.deepEqual(w.authorizations, [`Bearer ${secret}`, `Bearer ${secret}`]);
  assert.deepEqual(checkRequest(url), {
    url: `https://talkto.sh/v1/signals/${server}/${signal}`,
    secret,
  });
  assert.equal(checkRequest(`${url}/more`), null);
  assert.equal(checkRequest("https://talkto.sh/v1/servers"), null);
});

test("continuations are capped even on hosts without a cap of their own", async () => {
  const w = world(
    Array.from({ length: 10 }, (_, n) => ({ pending: 1, urgent: 0, cursor: message(n) })),
  );
  linked(w);
  const replies = [];
  replies.push(await handle(hook("stop"), w.deps));
  for (let n = 0; n < 5; n++)
    replies.push(await handle(hook("stop", { stopActive: true }), w.deps));
  assert.equal(
    replies.filter((reply) => reply.continueWith !== undefined).length,
    defaults.maxContinuations,
  );
  // A new turn starts counting again.
  assert.ok((await handle(hook("stop"), w.deps)).continueWith);
});

test("after a tool only urgent messages speak, at most once per interval; normal ones wait for the turn end", async () => {
  const w = world([
    { pending: 1, urgent: 0, cursor: message(1) },
    { pending: 2, urgent: 1, cursor: message(2) },
    { pending: 1, urgent: 0, cursor: message(3) },
  ]);
  linked(w);
  assert.deepEqual(await handle(hook("afterTool", { toolName: "Bash" }), w.deps), {});
  assert.equal(w.state.cursor, null, "a normal message is still waiting for the turn end");
  // Within the interval no request is made at all.
  assert.deepEqual(await handle(hook("afterTool", { toolName: "Bash" }), w.deps), {});
  assert.equal(w.requests.length, 1);
  w.tick(defaults.afterToolIntervalMs);
  const urgent = await handle(hook("afterTool", { toolName: "Bash" }), w.deps);
  assert.match(urgent.context, /^TalkTo: 1 urgent direct message just arrived\./);
  assert.equal(w.state.cursor, message(2));
  // The turn end always checks, whatever the interval.
  assert.match(
    (await handle(hook("stop"), w.deps)).continueWith,
    /1 new message\. Call get_updates to read it/,
  );
  assert.equal(w.requests.length, 3);
});

test("an idle session hears about waiting messages with the next prompt", async () => {
  const w = world([{ pending: 3, urgent: 0, cursor: message(3), more: true }]);
  linked(w);
  const reply = await handle(hook("promptSubmit"), w.deps);
  assert.match(reply.context, /More than 3 new messages arrived while you were idle/);
});

test("offline, slow, failing and rate-limited links stay quiet and back off", async () => {
  const w = world([new Error("offline"), 503, 429, { pending: 1, urgent: 1, cursor: message(1) }]);
  linked(w);
  assert.deepEqual(await handle(hook("stop"), w.deps), {});
  assert.deepEqual(await handle(hook("stop"), w.deps), {}, "inside the backoff no request is made");
  assert.equal(w.requests.length, 1);
  w.tick(defaults.backoffMs);
  assert.deepEqual(await handle(hook("stop"), w.deps), {});
  w.tick(defaults.backoffMs);
  assert.deepEqual(await handle(hook("stop"), w.deps), {});
  w.tick(29_000);
  assert.deepEqual(await handle(hook("stop"), w.deps), {}, "Retry-After is respected");
  assert.equal(w.requests.length, 3);
  w.tick(1_000);
  assert.ok((await handle(hook("stop"), w.deps)).continueWith);
  // A malformed answer is a quiet failure too.
  const odd = world([{ pending: "two", urgent: 0 }]);
  linked(odd);
  assert.deepEqual(await handle(hook("stop"), odd.deps), {});
});

test("an expired or revoked link is reported once, quietly, never by holding the turn open", async () => {
  const w = world([404]);
  linked(w);
  assert.deepEqual(await handle(hook("stop"), w.deps), {}, "the turn end is not held open for it");
  assert.equal(w.state.dead, true);
  const told = await handle(hook("afterTool", { toolName: "Bash" }), w.deps);
  assert.equal(told.context, notices.dead());
  assert.deepEqual(await handle(hook("promptSubmit"), w.deps), {});
  assert.equal(w.requests.length, 1, "a dead link is never asked again");
  // Expiry by the saved time needs no request.
  const old = world();
  old.state = fresh(url, signal, new Date(0).toISOString());
  assert.equal((await handle(hook("promptSubmit"), old.deps)).context, notices.dead());
  assert.equal(old.requests.length, 0);
});

test("skipped events (a session closing, an aborted turn) do nothing", async () => {
  const w = world([{ pending: 5, urgent: 5 }]);
  linked(w);
  assert.deepEqual(await handle(hook("stop", { skip: true }), w.deps), {});
  assert.equal(w.requests.length, 0);
});

test("state files are private, outside the project, keyed per session, and hold no token", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "talkto-hooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.notEqual(stateKey("codex", "a", "/x"), stateKey("codex", "b", "/x"));
  assert.notEqual(stateKey("codex", "a", "/x"), stateKey("cursor", "a", "/x"));
  assert.equal(stateKey("codex", null, "/x"), stateKey("codex", null, "/x"));
  const store = fileStore(join(directory, "state"), stateKey("codex", "a", "/x"));
  await store.save(fresh(url, signal, later));
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "state"))).mode & 0o777, 0o700);
  const saved = await readFile(store.path, "utf8");
  assert.doesNotMatch(saved, /bearer|token|authorization/i);
  assert.equal((await store.load()).url, url);
  await store.forget();
  assert.equal(await store.load(), null);
});
