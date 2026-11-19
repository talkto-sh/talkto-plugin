// The OpenClaw plugin's delivery rules against a fake host and a fake signal link: saving a
// link, queued notices with a wake, urgent steering, the cursor, and what is never said.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Signals,
  defaults,
  engagedPollMillis,
  followFrom,
  keyOf,
  settingsFrom,
  release,
  settleMillis,
} from "../signals.mjs";

const server = "7c1e9a52-3b0f-4c55-9d7e-0d2f3c4b5a61";
const me = "22222222-2222-4222-8222-222222222222";
const signal = "0b7a3c1d-2e4f-4a6b-8c9d-1e2f3a4b5c6d";
const secret = "A".repeat(42) + "B";
const url = `https://talkto.sh/v1/signals/${server}/${signal}.${secret}`;
const message = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const later = new Date(Date.UTC(2030, 0, 1)).toISOString();
const session = "agent:main:main";

/** What TalkTo's create_signal answers, as OpenClaw's MCP client hands a tool result over. */
const signalResult = (link = url) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        data: {
          signalId: signal,
          url: link,
          expiresAt: later,
          selection: { channelIds: [], directChats: "own" },
          minIntervalSeconds: 10,
          procedure: "Your TalkTo hook saves this link by itself when it sees this result.",
        },
        included: { participants: [], conversations: [] },
        meta: {},
      }),
    },
  ],
  details: { mcpServer: "talkto", mcpTool: "create_signal" },
});

/** A fake OpenClaw host: a clock, a store, and a link whose answers the test scripts. */
const world = (settings = defaults, answers = []) => {
  let clock = 1_000_000;
  const w = {
    stored: new Map(),
    steers: [],
    notices: [],
    requests: [],
    plugins: [],
    steerAccepts: true,
    notifyAccepts: true,
    host: {
      steer: async (target, text, key) => {
        w.steers.push({ target, text, key });
        return w.steerAccepts;
      },
      notify: async (target, text, wake) => {
        w.notices.push({ target, text, wake });
        return w.notifyAccepts;
      },
      save: async (key, follow) => {
        w.stored.set(key, structuredClone(follow));
      },
      remove: async (key) => {
        w.stored.delete(key);
      },
      fetch: async (target, init) => {
        w.requests.push(target);
        w.plugins.push(init.headers["talkto-plugin"]);
        const next = answers.shift() ?? { pending: 0, urgent: 0 };
        if (next instanceof Error) throw next;
        if (Number.isInteger(next))
          return new Response("{}", {
            status: next,
            headers: next === 429 ? { "retry-after": "30" } : {},
          });
        return Response.json({ more: false, cursor: null, expiresAt: later, ...next });
      },
      now: () => clock,
    },
    answers,
    tick: (ms) => {
      clock += ms;
    },
  };
  w.signals = new Signals(w.host, settings);
  return w;
};
const call = (toolName, fields = {}) => ({
  toolName,
  params: new Map(Object.entries({ serverId: server, participantId: me })),
  result: undefined,
  failed: false,
  durationMs: 0,
  sessionKey: session,
  agentId: "main",
  ...fields,
});
const capture = (w, fields = {}) =>
  w.signals.observeTool(call("talkto__create_signal", { result: signalResult(), ...fields }));

test("a create_signal result is saved for the session and confirmed into the running turn", async () => {
  const w = world();
  await capture(w);
  const saved = w.stored.get(keyOf(session, server));
  assert.equal(saved.url, url);
  assert.equal(saved.participantId, me);
  assert.equal(saved.sessionKey, session);
  assert.equal(saved.agentId, "main");
  assert.equal(saved.cursor, null);
  assert.deepEqual(Object.keys(saved).sort(), [
    "agentId",
    "cursor",
    "dead",
    "deadNoticed",
    "expiresAt",
    "participantId",
    "serverId",
    "sessionKey",
    "signalId",
    "url",
    "version",
  ]);
  assert.match(w.steers[0].text, /signal link saved for your participant/);
  assert.equal(w.steers[0].target.sessionKey, session);
});

test("only a create_signal result from the named server, with a session, is trusted", async () => {
  const w = world();
  await w.signals.observeTool(call("talkto__send_message", { result: signalResult() }));
  await capture(w, { failed: true });
  await capture(w, { sessionKey: null });
  await capture(w, { params: new Map([["serverId", server]]) });
  await capture(w, {
    params: new Map([
      ["serverId", "11111111-1111-4111-8111-111111111111"],
      ["participantId", me],
    ]),
  });
  await capture(w, { result: signalResult(url.replace("https://", "http://")) });
  assert.equal(w.stored.size, 0);
  assert.equal(w.steers.length, 0);
});

test("idle: new messages become one notice with a wake, after the settle time", async () => {
  const w = world(defaults, [{ pending: 2, urgent: 0, cursor: message(2) }]);
  await capture(w);
  await w.signals.tick();
  assert.equal(w.requests.length, 1);
  assert.equal(w.notices.length, 1);
  const [notice] = w.notices;
  assert.equal(notice.wake, true);
  assert.equal(notice.target.sessionKey, session);
  assert.equal(notice.target.agentId, "main");
  assert.match(notice.text, /^TalkTo: 2 new messages for your participant/);
  assert.match(notice.text, /Call get_updates/);
  // The same counts are not announced twice while the notice waits for a turn.
  w.answers.push({ pending: 2, urgent: 0, cursor: message(2) });
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(w.notices.length, 1);
  // The wake's turn starts: the cursor moves on, and the next check counts only newer messages.
  await w.signals.runStarted(session, "run-1");
  assert.equal(w.stored.get(keyOf(session, server)).cursor, message(2));
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.match(w.requests.at(-1), new RegExp(`since=${message(2)}`));
});

test("a turn that is running holds normal notices until it ends and settles", async () => {
  const w = world(defaults, [{ pending: 1, urgent: 0, cursor: message(1) }]);
  await capture(w);
  await w.signals.runStarted(session, "run-1");
  await w.signals.tick();
  assert.equal(w.notices.length, 0);
  w.signals.runEnded(session, "run-1");
  await w.signals.tick();
  assert.equal(w.notices.length, 0, "a person about to type goes first");
  w.tick(settleMillis);
  await w.signals.tick();
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].text, /1 new message for/);
});

test("more messages before the turn starts update the notice with the new total", async () => {
  const w = world(defaults, [
    { pending: 1, urgent: 0, cursor: message(1) },
    { pending: 3, urgent: 0, cursor: message(3) },
  ]);
  await capture(w);
  await w.signals.tick();
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(w.notices.length, 2);
  assert.match(w.notices[1].text, /3 new messages/);
  assert.equal(w.notices[0].target.contextKey, w.notices[1].target.contextKey);
});

test("urgent while a turn runs: steered into it, and the cursor moves on", async () => {
  const w = world(defaults, [{ pending: 2, urgent: 1, cursor: message(2) }]);
  await capture(w);
  await w.signals.runStarted(session, "run-1");
  await w.signals.tick();
  assert.equal(w.notices.length, 0);
  const urgent = w.steers.at(-1);
  assert.match(urgent.text, /^TalkTo: 1 urgent direct message for your participant/);
  assert.match(urgent.text, /Finish the step you are on/);
  assert.equal(urgent.key, `talkto-plugin:urgent:${signal}:${message(2)}`);
  assert.equal(w.stored.get(keyOf(session, server)).cursor, message(2));
});

test("urgent refused by the runtime waits for the turn end, then wakes the session", async () => {
  const w = world(defaults, [
    { pending: 1, urgent: 1, cursor: message(1) },
    { pending: 1, urgent: 1, cursor: message(1) },
  ]);
  await capture(w);
  w.steerAccepts = false;
  await w.signals.runStarted(session, "run-1");
  await w.signals.tick();
  const steersAfterFirst = w.steers.length;
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(
    w.steers.length,
    steersAfterFirst,
    "a refused steer is not retried for the same messages",
  );
  w.signals.runEnded(session, "run-1");
  w.tick(settleMillis);
  await w.signals.tick();
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].wake, true);
  assert.match(w.notices[0].text, /1 new message, 1 urgent/);
});

test("urgent: queue treats urgent messages like any other", async () => {
  const w = world({ ...defaults, urgent: "queue" }, [
    { pending: 1, urgent: 1, cursor: message(1) },
  ]);
  await capture(w);
  await w.signals.runStarted(session, "run-1");
  await w.signals.tick();
  assert.equal(w.steers.length, 1, "only the saved confirmation");
});

test("next-prompt delivery queues without a wake, except for urgent messages", async () => {
  const w = world({ ...defaults, delivery: "next-prompt" }, [
    { pending: 1, urgent: 0, cursor: message(1) },
    { pending: 2, urgent: 1, cursor: message(2) },
  ]);
  await capture(w);
  await w.signals.tick();
  assert.equal(w.notices[0].wake, false);
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(w.notices[1].wake, true);
});

test("the person's wake cadence spaces wakes: inside the gap the notice waits for a prompt", async () => {
  const every5 = { wakeCadence: "every_5_minutes", wakeIntervalSeconds: 300 };
  const w = world(defaults, [{ pending: 1, urgent: 0, cursor: message(1), ...every5 }]);
  await capture(w);
  await w.signals.tick();
  assert.equal(w.notices.at(-1).wake, true, "the first batch after a quiet period wakes");
  await w.signals.runStarted(session, "run-1");
  w.signals.runEnded(session, "run-1");
  // A minute later a new batch goes in for the next prompt, without starting a turn.
  w.tick(60_000);
  w.answers.push({ pending: 1, urgent: 0, cursor: message(2), ...every5 });
  await w.signals.tick();
  assert.equal(w.notices.length, 2);
  assert.equal(w.notices[1].wake, false);
  // The same counts are not repeated while the gap lasts.
  w.tick(engagedPollMillis);
  w.answers.push({ pending: 1, urgent: 0, cursor: message(2), ...every5 });
  await w.signals.tick();
  assert.equal(w.notices.length, 2);
  // An urgent message wakes inside the gap.
  w.tick(engagedPollMillis);
  w.answers.push({ pending: 2, urgent: 1, cursor: message(3), ...every5 });
  await w.signals.tick();
  assert.equal(w.notices.at(-1).wake, true);
  await w.signals.runStarted(session, "run-2");
  w.signals.runEnded(session, "run-2");
  // Held normal counts get their wake once the gap since the last wake has passed.
  w.tick(60_000);
  w.answers.push({ pending: 1, urgent: 0, cursor: message(4), ...every5 });
  await w.signals.tick();
  assert.equal(w.notices.at(-1).wake, false);
  w.tick(300_000);
  w.answers.push({ pending: 1, urgent: 0, cursor: message(4), ...every5 });
  await w.signals.tick();
  assert.equal(w.notices.at(-1).wake, true);
  assert.equal(w.notices.at(-1).target.contextKey, w.notices.at(-2).target.contextKey);
});

test("channel messages alone never wake: they wait for the next prompt, and a mention wakes", async () => {
  const w = world(defaults, [{ pending: 2, urgent: 0, waking: 0, cursor: message(2) }]);
  await capture(w);
  await w.signals.tick();
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].wake, false, "other channel messages wait for the next prompt");
  assert.match(
    w.notices[0].text,
    /^TalkTo: 2 new messages for your participant \S+ on server \S+ \(channel messages only, none for you\)\./,
  );
  // The same counts are not repeated.
  w.tick(engagedPollMillis);
  w.answers.push({ pending: 2, urgent: 0, waking: 0, cursor: message(2) });
  await w.signals.tick();
  assert.equal(w.notices.length, 1);
  // A direct message, @mention or TalkTo notice arrives: now a turn starts, with all of them.
  w.tick(engagedPollMillis);
  w.answers.push({ pending: 3, urgent: 0, waking: 1, cursor: message(3) });
  await w.signals.tick();
  assert.equal(w.notices.length, 2);
  assert.equal(w.notices[1].wake, true);
  assert.match(
    w.notices[1].text,
    /\(1 for you: direct messages, @mentions or TalkTo notices; 2 other channel messages\)\./,
  );
  await w.signals.runStarted(session, "run-1");
  assert.equal(w.stored.get(keyOf(session, server)).cursor, message(3));
});

test("right away, and a server without a cadence, wake for every batch as before", async () => {
  for (const extra of [{ wakeCadence: "right_away", wakeIntervalSeconds: 0 }, {}]) {
    const w = world(defaults, [{ pending: 1, urgent: 0, cursor: message(1), ...extra }]);
    await capture(w);
    await w.signals.tick();
    await w.signals.runStarted(session, "run-1");
    w.signals.runEnded(session, "run-1");
    w.tick(settleMillis + engagedPollMillis);
    w.answers.push({ pending: 1, urgent: 0, cursor: message(2), ...extra });
    await w.signals.tick();
    assert.deepEqual(
      w.notices.map((notice) => notice.wake),
      [true, true],
    );
  }
});

test("a get_updates read after the counts settles them, from any session", async () => {
  const w = world(defaults, [{ pending: 2, urgent: 0, cursor: message(2) }]);
  await capture(w);
  await w.signals.runStarted(session, "run-1");
  await w.signals.tick();
  w.tick(5_000);
  // The agent polled by itself in its running turn (or in an isolated heartbeat session).
  await w.signals.observeTool(
    call("talkto__get_updates", { sessionKey: "agent:main:heartbeat", durationMs: 1_000 }),
  );
  assert.equal(w.stored.get(keyOf(session, server)).cursor, message(2));
  w.signals.runEnded(session, "run-1");
  w.tick(settleMillis);
  await w.signals.tick();
  assert.equal(w.notices.length, 0);
});

test("a read that began before the counts does not settle them", async () => {
  const w = world(defaults, [{ pending: 1, urgent: 0, cursor: message(1) }]);
  await capture(w);
  await w.signals.runStarted(session, "run-1");
  await w.signals.tick();
  await w.signals.observeTool(call("talkto__get_updates", { durationMs: 20_000 }));
  assert.equal(w.stored.get(keyOf(session, server)).cursor, null);
});

test("a dead link is told once, then never checked again", async () => {
  const w = world(defaults, [404]);
  await capture(w);
  await w.signals.tick();
  assert.equal(w.stored.get(keyOf(session, server)).dead, true);
  w.tick(settleMillis);
  await w.signals.tick();
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].text, /stopped working/);
  assert.equal(w.notices[0].wake, false);
  w.tick(defaults.pollMillis * 10);
  await w.signals.tick();
  assert.equal(w.requests.length, 1);
  assert.equal(w.notices.length, 1);
});

test("failures and rate limits are quiet and back off", async () => {
  const w = world(defaults, [new Error("offline"), 429]);
  await capture(w);
  await w.signals.tick();
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(w.requests.length, 1, "quiet for a minute after a failure");
  w.tick(60_000);
  await w.signals.tick();
  assert.equal(w.requests.length, 2);
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(w.requests.length, 2, "Retry-After is honored");
  assert.equal(w.notices.length, 0);
});

test("an idle session is checked less often than an engaged one", async () => {
  const w = world();
  await capture(w);
  await w.signals.tick();
  w.tick(11 * 60_000);
  await w.signals.tick();
  const checks = w.requests.length;
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(w.requests.length, checks);
  w.tick(defaults.pollMillis);
  await w.signals.tick();
  assert.equal(w.requests.length, checks + 1);
});

test("revoke_signal and a reset session forget the link", async () => {
  const w = world();
  await capture(w);
  await w.signals.observeTool(call("talkto__revoke_signal"));
  assert.equal(w.stored.size, 0);
  await capture(w);
  await w.signals.endSession(session, "idle");
  assert.equal(w.stored.size, 1);
  await w.signals.endSession(session, "reset");
  assert.equal(w.stored.size, 0);
});

test("follows survive a restart; malformed rows are dropped", async () => {
  const first = world();
  await capture(first);
  const w = world(defaults, [{ pending: 1, urgent: 0, cursor: message(1) }]);
  w.signals.restore([
    ...[...first.stored].map(([key, value]) => ({ key, value })),
    { key: "x", value: { version: 1, url: "https://evil.example/x" } },
    { key: "y", value: null },
  ]);
  await w.signals.tick();
  assert.equal(w.notices.length, 1);
  assert.equal(followFrom({ ...first.stored.values().next().value, version: 2 }), null);
});

test("settings fall back to safe defaults", () => {
  assert.deepEqual(settingsFrom(new Map()), defaults);
  assert.deepEqual(
    settingsFrom(
      new Map(Object.entries({ delivery: "next-prompt", urgent: "queue", pollSeconds: 60 })),
    ),
    { delivery: "next-prompt", urgent: "queue", pollMillis: 60_000 },
  );
  assert.equal(settingsFrom(new Map([["pollSeconds", 1]])).pollMillis, defaults.pollMillis);
});

test("no notice carries message text, names or the link", async () => {
  const w = world(defaults, [{ pending: 1, urgent: 1, cursor: message(1) }]);
  await capture(w);
  await w.signals.tick();
  for (const text of [...w.steers, ...w.notices].map((entry) => entry.text)) {
    assert.doesNotMatch(text, /\/v1\/signals\//);
    assert.doesNotMatch(text, new RegExp(secret));
  }
  assert.match(w.signals.describe(session), /1 waiting, 1 urgent/);
  assert.doesNotMatch(w.signals.describe(session), new RegExp(secret));
});

test("each check names the plugin; a newer version adds one line to a queued notice a day", async () => {
  const w = world(defaults, [
    { pending: 1, urgent: 0, cursor: message(1), latestPluginVersion: "99.0.0" },
    { pending: 2, urgent: 0, cursor: message(2), latestPluginVersion: "99.0.0" },
  ]);
  await capture(w);
  await w.signals.tick();
  assert.equal(w.plugins[0], `openclaw/${release.version}`);
  assert.equal(w.notices.length, 1);
  assert.ok(
    w.notices[0].text.endsWith(
      `Tell your person: a TalkTo plugin update is available (${release.version} → 99.0.0). To install it, stop the Gateway, run \`openclaw plugins update talkto-plugin\`, then start the Gateway again. What changed: https://talkto.sh/docs/updates/`,
    ),
    w.notices[0].text,
  );
  assert.match(w.signals.describe(session), /TalkTo plugin update is available/);
  await w.signals.runStarted(session, "run-1");
  w.signals.runEnded(session, "run-1");
  w.tick(engagedPollMillis);
  await w.signals.tick();
  assert.equal(w.notices.length, 2);
  assert.doesNotMatch(w.notices[1].text, /plugin update/, "not twice in a day");
});

test("no update line when the plugin is current", async () => {
  const w = world(defaults, [
    { pending: 1, urgent: 0, cursor: message(1), latestPluginVersion: release.version },
  ]);
  await capture(w);
  await w.signals.tick();
  assert.doesNotMatch(w.notices[0].text, /plugin update/);
  assert.doesNotMatch(w.signals.describe(session), /plugin update/);
});
