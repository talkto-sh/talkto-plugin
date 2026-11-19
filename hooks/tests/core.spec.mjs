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
  watchStep,
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
  const plugins = [];
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
      plugins.push(init.headers["talkto-plugin"]);
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
    idleNote: "IDLE NOTE.",
  };
  return {
    deps,
    requests,
    authorizations,
    plugins,
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
  foundLink: null,
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

test("a link the host found elsewhere is saved once, only while new and live", async () => {
  const w = world();
  const foundLink = { url, signalId: signal, expiresAt: later };
  const first = await handle(hook("afterTool", { foundLink }), w.deps);
  assert.equal(first.context, notices.saved());
  assert.equal(w.state.url, url);
  assert.equal(w.requests.length, 0);
  // A host can add what the agent does next (Antigravity: start the watcher).
  const withNote = world();
  withNote.deps.savedNote = "START THE WATCHER.";
  assert.equal(
    (await handle(hook("afterTool", { foundLink }), withNote.deps)).context,
    `${notices.saved()} START THE WATCHER.`,
  );
  // The host shows the newest result before every model call: the same link is not saved again.
  w.state = { ...w.state, cursor: message(1) };
  assert.deepEqual(await handle(hook("afterTool", { foundLink }), w.deps), {});
  assert.equal(w.state.cursor, message(1));
  // A link that died stays dead; only a newer create_signal result replaces it.
  w.state = { ...w.state, dead: true, deadNoticed: true };
  assert.deepEqual(await handle(hook("afterTool", { foundLink }), w.deps), {});
  assert.equal(w.state.dead, true);
  const rotated = `https://talkto.sh/v1/signals/${server}/${message(9)}.${secret}`;
  const next = { url: rotated, signalId: message(9), expiresAt: later };
  assert.equal(
    (await handle(hook("afterTool", { foundLink: next }), w.deps)).context,
    notices.saved(),
  );
  assert.deepEqual([w.state.url, w.state.dead], [rotated, false]);
  // An expired link is never saved.
  const old = world();
  const expired = { ...foundLink, expiresAt: new Date(old.deps.now()).toISOString() };
  assert.deepEqual(await handle(hook("afterTool", { foundLink: expired }), old.deps), {});
  assert.equal(old.state, null);
  // At a turn end the link is saved quietly, and the turn end checks it at once.
  const s = world([{ pending: 2, urgent: 0, cursor: message(3) }]);
  const stop = await handle(hook("stop", { foundLink }), s.deps);
  assert.equal(stop.continueWith, notices.waiting({ pending: 2, urgent: 0, more: false }));
  assert.equal(s.state.url, url);
});

test("without a link the session start says how to join, once; nothing else speaks", async () => {
  const w = world();
  const start = await handle(hook("sessionStart"), w.deps);
  assert.match(start.context, /create_signal/);
  assert.match(
    start.context,
    /IDLE NOTE\. If the hook does not confirm the link, save it with: node hook save$/,
  );
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

test("the person's wake cadence spaces turn-end continuations; urgent ones always continue", async () => {
  const every5 = { wakeCadence: "every_5_minutes", wakeIntervalSeconds: 300 };
  const w = world([
    { pending: 1, urgent: 0, cursor: message(1), ...every5 },
    { pending: 1, urgent: 0, cursor: message(2), ...every5 },
    { pending: 1, urgent: 0, cursor: message(2), ...every5 },
    { pending: 1, urgent: 1, cursor: message(3), ...every5 },
    { pending: 1, urgent: 0, cursor: message(4), ...every5 },
    { pending: 1, urgent: 0, cursor: message(4), ...every5 },
  ]);
  linked(w);
  // The first batch after a quiet period continues at once.
  assert.ok((await handle(hook("stop"), w.deps)).continueWith);
  assert.equal(w.state.cursor, message(1));
  // A minute later the next batch is held: the turn ends, and the cursor stays where it was.
  w.tick(60_000);
  assert.deepEqual(await handle(hook("stop"), w.deps), {});
  assert.equal(w.state.cursor, message(1));
  assert.equal(w.state.continuations, 0);
  // The person's next prompt still hears about it.
  w.tick(defaults.promptIntervalMs);
  assert.match((await handle(hook("promptSubmit"), w.deps)).context, /1 new message arrived/);
  assert.equal(w.state.cursor, message(2));
  // An urgent message continues inside the gap.
  w.tick(10_000);
  assert.match((await handle(hook("stop"), w.deps)).continueWith, /1 urgent/);
  // Once the gap has passed since that wake, a normal batch continues again.
  assert.deepEqual(await handle(hook("stop"), w.deps), {});
  w.tick(300_000);
  assert.ok((await handle(hook("stop"), w.deps)).continueWith);
});

test("right away, and a server without a cadence, continue for every batch as before", async () => {
  for (const extra of [{ wakeCadence: "right_away", wakeIntervalSeconds: 0 }, {}]) {
    const w = world(
      Array.from({ length: 3 }, (_, n) => ({
        pending: 1,
        urgent: 0,
        cursor: message(n),
        ...extra,
      })),
    );
    linked(w);
    assert.ok((await handle(hook("stop"), w.deps)).continueWith);
    assert.ok((await handle(hook("stop", { stopActive: true }), w.deps)).continueWith);
    assert.ok((await handle(hook("stop", { stopActive: true }), w.deps)).continueWith);
  }
});

test("an idle session hears about waiting messages with the next prompt", async () => {
  const w = world([{ pending: 3, urgent: 0, cursor: message(3), more: true }]);
  linked(w);
  const reply = await handle(hook("promptSubmit"), w.deps);
  assert.match(reply.context, /More than 3 new messages arrived while you were idle/);
});

test("only direct messages, @mentions and TalkTo notices continue a turn; other channel messages wait for the next prompt", async () => {
  const w = world([
    { pending: 3, urgent: 0, waking: 0, cursor: message(3) },
    { pending: 3, urgent: 0, waking: 0, cursor: message(3) },
    { pending: 2, urgent: 0, waking: 0, cursor: message(5) },
    { pending: 4, urgent: 0, waking: 1, cursor: message(9) },
  ]);
  linked(w);
  // Channel posts alone: the turn ends, the cursor stays, and the count waits for the next prompt.
  assert.deepEqual(await handle(hook("stop"), w.deps), {});
  assert.equal(w.state.cursor, null);
  assert.equal(w.state.pending, 3);
  assert.equal(w.state.continuations, 0);
  assert.deepEqual(await handle(hook("stop"), w.deps), {});
  // The next prompt mentions them quietly, as context, and moves the cursor past them.
  w.tick(defaults.promptIntervalMs);
  const prompt = await handle(hook("promptSubmit"), w.deps);
  assert.equal(
    prompt.context,
    "TalkTo: 2 new messages (channel messages only, none for you) arrived while you were idle. Call get_updates to read them when it fits this request.",
  );
  assert.equal(w.state.cursor, message(5));
  // One message for the agent continues the turn, and the channel posts ride along with it.
  const woken = await handle(hook("stop"), w.deps);
  assert.equal(
    woken.continueWith,
    "TalkTo: 4 new messages (1 for you: direct messages, @mentions or TalkTo notices; 3 other channel messages). Call get_updates to read them, then carry on.",
  );
  assert.equal(w.state.cursor, message(9));
});

test("a server without the waking count, or with an odd one, keeps the old rule: every message continues", async () => {
  for (const waking of [undefined, -1, 101, "2", null]) {
    const w = world([{ pending: 2, urgent: 0, cursor: message(2), waking }]);
    linked(w);
    const reply = await handle(hook("stop"), w.deps);
    assert.equal(
      reply.continueWith,
      "TalkTo: 2 new messages. Call get_updates to read them, then carry on.",
      String(waking),
    );
  }
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

test("hooks record whether a turn runs: a prompt or tool step starts it, Stop ends it unless it continues", async () => {
  const w = world([
    { pending: 0, urgent: 0 },
    { pending: 0, urgent: 0 },
    { pending: 1, urgent: 0, cursor: message(1) },
  ]);
  linked(w);
  assert.equal(w.state.turnActive, false);
  await handle(hook("afterTool"), w.deps);
  assert.equal(w.state.turnActive, true);
  await handle(hook("stop"), w.deps);
  assert.equal(w.state.turnActive, false);
  await handle(hook("promptSubmit"), w.deps);
  assert.equal(w.state.turnActive, true);
  w.tick(1_000);
  assert.ok((await handle(hook("stop"), w.deps)).continueWith);
  assert.equal(w.state.turnActive, true, "a continued turn still runs");
  // An aborted or failed turn says nothing, but it is over.
  assert.deepEqual(await handle(hook("stop", { skip: true }), w.deps), {});
  assert.equal(w.state.turnActive, false);
  // A link saved from a tool result is saved inside a running turn.
  w.state = null;
  const saved = { data: { url, expiresAt: later, signalId: signal } };
  await handle(hook("afterTool", { toolName: "create_signal", toolResponse: saved }), w.deps);
  assert.equal(w.state.turnActive, true);
});

/** A linked world whose last turn ended, as after a Stop. */
const idleWorld = (answers) => {
  const w = world(answers);
  linked(w);
  w.state = { ...w.state, turnActive: false, turnSeenAt: 1 };
  return w;
};

test("the watcher starts a turn while idle, announces each batch once, and stays quiet inside a turn", async () => {
  const w = idleWorld([
    { pending: 2, urgent: 0, cursor: message(2) },
    { pending: 0, urgent: 0, cursor: message(2) },
  ]);
  const wake = await watchStep(w.deps);
  assert.deepEqual(wake, { kind: "wake", notice: notices.waiting({ pending: 2, urgent: 0 }) });
  // The batch and the turn are claimed before the turn starts.
  assert.equal(w.state.cursor, message(2));
  assert.equal(w.state.turnActive, true);
  assert.equal(w.state.lastWakeAt, 1_000_000);
  // While that turn runs the watcher never checks: the hooks speak inside a turn.
  w.tick(60_000);
  assert.deepEqual(await watchStep(w.deps), { kind: "wait", ms: defaults.watchIntervalMs });
  assert.equal(w.requests.length, 1);
  // After the turn's Stop, it checks again with the moved cursor.
  w.state = { ...w.state, turnActive: false, turnSeenAt: w.deps.now() };
  assert.deepEqual(await watchStep(w.deps), { kind: "wait", ms: defaults.watchIntervalMs });
  assert.match(w.requests[1], new RegExp(`since=${message(2)}`));
  // Checks are spaced by the watch interval, which the hooks' checks also count toward.
  assert.deepEqual(await watchStep(w.deps), { kind: "wait", ms: defaults.watchIntervalMs });
  assert.equal(w.requests.length, 2);
});

test("the watcher never starts a turn for channel messages alone; a direct message, @mention or notice does", async () => {
  const w = idleWorld([
    { pending: 2, urgent: 0, waking: 0, cursor: message(2) },
    { pending: 3, urgent: 0, waking: 1, cursor: message(3) },
  ]);
  assert.deepEqual(await watchStep(w.deps), { kind: "wait", ms: defaults.watchIntervalMs });
  assert.equal(w.state.cursor, null, "the held messages stay counted for the next turn");
  assert.equal(w.state.lastWakeAt, 0);
  w.tick(defaults.watchIntervalMs);
  assert.deepEqual(await watchStep(w.deps), {
    kind: "wake",
    notice: notices.waiting({ pending: 3, urgent: 0, waking: 1, more: false }),
  });
  assert.equal(w.state.cursor, message(3));
});

test("the watcher holds normal messages for the person's wake cadence; urgent ones start a turn at once", async () => {
  const every5 = { wakeCadence: "every_5_minutes", wakeIntervalSeconds: 300 };
  const w = idleWorld([
    { pending: 1, urgent: 0, cursor: message(1), ...every5 },
    { pending: 1, urgent: 0, cursor: message(2), ...every5 },
    { pending: 2, urgent: 1, cursor: message(3), ...every5 },
  ]);
  w.state = { ...w.state, lastWakeAt: w.deps.now() - 290_000 };
  // Ten seconds of the gap remain: wait them out, and keep the cursor.
  assert.deepEqual(await watchStep(w.deps), { kind: "wait", ms: 10_000 });
  assert.equal(w.state.cursor, null);
  w.tick(defaults.watchIntervalMs);
  assert.equal((await watchStep(w.deps)).kind, "wake");
  // Right after that wake, an urgent message skips the gap.
  w.state = { ...w.state, turnActive: false };
  w.tick(defaults.watchIntervalMs);
  assert.deepEqual(await watchStep(w.deps), {
    kind: "wake",
    notice: notices.waiting({ pending: 2, urgent: 1 }),
  });
});

test("a Stop that held a batch for the cadence leaves it to the watcher, which wakes once the gap passes", async () => {
  const every1 = { wakeCadence: "every_minute", wakeIntervalSeconds: 60 };
  const w = world([
    { pending: 1, urgent: 0, cursor: message(1), ...every1 },
    { pending: 1, urgent: 0, cursor: message(2), ...every1 },
    { pending: 1, urgent: 0, cursor: message(2), ...every1 },
  ]);
  linked(w);
  assert.ok((await handle(hook("stop"), w.deps)).continueWith);
  w.tick(20_000);
  assert.deepEqual(await handle(hook("stop", { stopActive: true }), w.deps), {});
  assert.equal(w.state.turnActive, false);
  w.tick(40_000);
  assert.equal((await watchStep(w.deps)).kind, "wake");
  assert.equal(w.state.cursor, message(2));
});

test("the watcher stops when there is no link or the link dies, and treats a stale turn as over", async () => {
  const none = world();
  assert.deepEqual(await watchStep(none.deps), { kind: "end", notice: notices.watchNoLink() });
  const dying = idleWorld([404]);
  assert.deepEqual(await watchStep(dying.deps), { kind: "end", notice: notices.watchDead() });
  assert.equal(dying.state.deadNoticed, true);
  assert.deepEqual(await watchStep(dying.deps), { kind: "end", notice: notices.watchDead() });
  // A turn whose Stop never came (a crash) blocks the watcher only for a while.
  const stuck = world([{ pending: 1, urgent: 0, cursor: message(1) }]);
  linked(stuck);
  stuck.state = { ...stuck.state, turnActive: true, turnSeenAt: stuck.deps.now() };
  assert.equal((await watchStep(stuck.deps)).kind, "wait");
  stuck.tick(defaults.turnStaleMs);
  assert.equal((await watchStep(stuck.deps)).kind, "wake");
  // Offline: quiet, and it keeps watching.
  const offline = idleWorld([new Error("offline")]);
  assert.deepEqual(await watchStep(offline.deps), { kind: "wait", ms: defaults.watchIntervalMs });
});

test("a hook that writes while the watcher checks wins; the watcher looks again later", async () => {
  const w = idleWorld([{ pending: 1, urgent: 1, cursor: message(1) }]);
  const fetch = w.deps.fetch;
  // A PreInvocation hook starts a turn while the watcher's check is in flight.
  w.deps.fetch = async (...args) => {
    const response = await fetch(...args);
    w.state = { ...w.state, turnActive: true, turnSeenAt: w.deps.now() + 1 };
    return response;
  };
  assert.deepEqual(await watchStep(w.deps), { kind: "wait", ms: defaults.watchIntervalMs });
  assert.equal(w.state.turnActive, true);
  assert.equal(w.state.cursor, null);
});

const release = { name: "hooks", version: "0.3.0", steps: "run `update-it`" };
const updateText =
  "Tell your person: a TalkTo hooks update is available (0.3.0 → 0.4.0). To install it, run `update-it`. What changed: https://talkto.sh/docs/updates/";

test("each check names the plugin in TalkTo-Plugin; callers without a release send no header", async () => {
  const w = world([
    { pending: 0, urgent: 0 },
    { pending: 0, urgent: 0 },
  ]);
  linked(w);
  await handle(hook("stop"), w.deps);
  assert.equal(w.plugins[0], undefined, "an older caller sends nothing new");
  w.deps.release = release;
  w.tick(defaults.promptIntervalMs);
  await handle(hook("stop"), w.deps);
  assert.equal(w.plugins[1], "hooks/0.3.0");
});

test("a newer version adds one line to what the agent is told anyway, at most once a day", async () => {
  const w = world([
    { pending: 0, urgent: 0, latestPluginVersion: "0.4.0" },
    { pending: 2, urgent: 0, latestPluginVersion: "0.4.0" },
    { pending: 1, urgent: 0, latestPluginVersion: "0.4.0" },
    { pending: 1, urgent: 0, latestPluginVersion: "0.4.0" },
  ]);
  w.deps.release = release;
  linked(w);
  assert.deepEqual(await handle(hook("stop"), w.deps), {}, "a quiet turn end stays quiet");
  assert.equal(w.state.latestVersion, "0.4.0");
  w.tick(1);
  const told = await handle(hook("stop"), w.deps);
  assert.equal(
    told.continueWith,
    `${notices.waiting({ pending: 2, urgent: 0, more: false })} ${updateText}`,
  );
  w.tick(1);
  const again = await handle(hook("stop", { stopActive: true }), w.deps);
  assert.equal(
    again.continueWith,
    notices.waiting({ pending: 1, urgent: 0, more: false }),
    "not twice in a day",
  );
  w.tick(24 * 60 * 60_000);
  const nextDay = await handle(hook("promptSubmit"), w.deps);
  assert.ok(nextDay.context?.endsWith(updateText), nextDay.context);
});

test("no update line when the plugin is current or newer, or the server names an odd version", async () => {
  for (const latestPluginVersion of ["0.3.0", "0.2.9", "0.4", "soon", null]) {
    const w = world([{ pending: 1, urgent: 0, latestPluginVersion }]);
    w.deps.release = release;
    linked(w);
    const reply = await handle(hook("stop"), w.deps);
    assert.equal(reply.continueWith, notices.waiting({ pending: 1, urgent: 0, more: false }));
  }
});
