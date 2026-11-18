// talkto-plugin for pi against a fake pi and a fake TalkTo: sign-in held by
// pi, TalkTo's tools, the follow, and delivery between and inside turns.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extension, confirmMillis } from "../extension.ts";
import { login, renew } from "../login.ts";

const server = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const peer = "33333333-3333-4333-8333-333333333333";
const general = "44444444-4444-4444-8444-444444444444";
const direct = "55555555-5555-4555-8555-555555555555";
const mcpUrl = "https://talkto.test/mcp";

const json = (status, body) => ({
  status,
  headers: { get: (name) => (name === "content-type" ? "application/json" : null) },
  text: async () => JSON.stringify(body),
});
const page = (messages, checkpoint) => ({
  isError: false,
  content: [],
  structuredContent: {
    data: { messages, checkpoint, nextCursor: null },
    included: {
      participants: [{ id: peer, name: "planner", agentType: "codex" }],
      conversations: [
        { id: general, kind: "channel", name: "general" },
        { id: direct, kind: "direct", participantIds: [me, peer] },
      ],
    },
    meta: {},
  },
});
/** TalkTo refusing a call's input, as it refuses a wait longer than it allows. */
const refusal = (text) => ({
  isError: true,
  content: [],
  structuredContent: { error: { code: "invalid_input", message: text }, meta: {} },
});
let sequence = 0;
const message = (fields = {}) => {
  sequence += 1;
  return {
    id: `m-${sequence}`,
    sequence,
    conversationId: general,
    senderId: peer,
    body: `hello ${sequence}`,
    createdAt: "2026-11-11T10:00:00.000Z",
    ...fields,
  };
};

/** TalkTo's MCP endpoint: tools/list, and get_updates answered from a queue. */
/** What the fake TalkTo answers get_context with: the server and its General channel. */
const context = JSON.stringify({
  data: { server: { id: server, generalConversationId: general } },
});

const fakeTalkTo = () => {
  const talkto = {
    calls: [],
    updates: [],
    /**
     * When set, a waiting get_updates with nothing new is held, as TalkTo holds it: until a page is
     * queued, or until its deadline, when it answers empty.
     */
    hold: false,
    /** The longest wait TalkTo allows a call that names its plugin; 20 before November 17, 2026. */
    pluginWait: 50,
    fetch: async (url, init) => {
      assert.equal(url, mcpUrl);
      const body = JSON.parse(init.body);
      talkto.calls.push({
        token: init.headers.authorization,
        method: body.method,
        params: body.params,
      });
      if (init.headers.authorization !== "Bearer live-token") return json(401, {});
      if (body.method === "tools/list")
        return json(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "get_context", description: "Start here.", inputSchema: { type: "object" } },
              { name: "send_message", description: "Send.", inputSchema: { type: "object" } },
              { name: "get_updates", description: "Read.", inputSchema: { type: "object" } },
            ],
          },
        });
      const result =
        body.params.name === "get_updates"
          ? await talkto.updatesFor(body.params.arguments ?? {})
          : body.params.name === "get_context"
            ? { isError: false, content: [{ type: "text", text: context }] }
            : { isError: false, content: [{ type: "text", text: `{"ok":"${body.params.name}"}` }] };
      return json(200, { jsonrpc: "2.0", id: body.id, result });
    },
    updatesFor: async (args) => {
      const wait = args.waitSeconds ?? 0;
      const longest = args.plugin === undefined ? 20 : talkto.pluginWait;
      if (wait > longest) return refusal(`waitSeconds must be a value between 0 and ${longest}`);
      for (let held = 0; talkto.hold && held < wait && talkto.updates.length === 0; held += 1)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      return talkto.updates.shift() ?? page([], `cp-${sequence}`);
    },
  };
  return talkto;
};

/** A pi whose handlers, tools and sent messages are recorded, with a ctx the test controls. */
const fakePi = () => {
  const pi = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    providers: new Map(),
    sent: [],
    notices: [],
    statuses: [],
    idle: true,
    signedIn: true,
    mode: "tui",
    on: (event, handler) => pi.handlers.set(event, handler),
    registerTool: (tool) => pi.tools.set(tool.name, tool),
    registerCommand: (name, options) => pi.commands.set(name, options),
    registerProvider: (name, config) => pi.providers.set(name, config),
    sendUserMessage: (text, options) => pi.sent.push({ text, deliverAs: options.deliverAs }),
    ctx: () => ({
      mode: pi.mode,
      hasUI: pi.mode === "tui",
      ui: {
        setStatus: (_key, text) => pi.statuses.push(text),
        notify: (text) => pi.notices.push(text),
      },
      isIdle: () => pi.idle,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      modelRegistry: {
        getProviderAuth: async (name) =>
          name === "talkto" && pi.signedIn ? { auth: { apiKey: "live-token" } } : undefined,
      },
    }),
    emit: async (event, data = {}) => pi.handlers.get(event)?.({ type: event, ...data }, pi.ctx()),
    /** pi shows a sent message as the next user message. */
    show: (text) =>
      pi.emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } }),
  };
  return pi;
};

const settings = { delivery: "idle", urgent: "inject", pollMillis: 15000, wait: "auto" };
/** A file request in flight, or the close of a file written: what a state save waits on. */
const fileRequest = /^(?:FSReq|CloseReq|FileHandle)/;
/**
 * Lets the extension finish what a tick started, its state file writes included, before the mocked
 * clock moves on: it waits until no file request has been pending for 40 event-loop turns. A fixed
 * number of turns let a slow disk (a busy CI machine) fall behind the clock, so a save, and the
 * check or delivery after it, ran mocked seconds late.
 */
const settle = async () => {
  let quiet = 0;
  for (let round = 0; quiet < 40; round += 1) {
    assert.ok(round < 1_000_000, "a file request never ended");
    await new Promise((resolve) => setImmediate(resolve));
    const writing = process.getActiveResourcesInfo().some((kind) => fileRequest.test(kind));
    quiet = writing ? 0 : quiet + 1;
  }
};
const start = async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const stateDir = await mkdtemp(join(tmpdir(), "talkto-pi-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const talkto = fakeTalkTo();
  const pi = fakePi();
  extension({ mcpUrl, fetch: talkto.fetch, now: () => Date.now(), stateDir, settings })(pi);
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { pi, talkto, stateDir, advance };
};
const follow = (pi) =>
  pi.tools.get("talkto_follow").execute("call-1", {
    serverId: server,
    participantId: me,
    channelIds: [],
    fullChannelIds: [general],
    directChats: "own",
  });

test("loading registers the TalkTo sign-in, the follow tools and the inbox command", async (t) => {
  const { pi } = await start(t);
  const provider = pi.providers.get("talkto");
  assert.equal(provider.name, "TalkTo");
  assert.equal(provider.oauth.name, "TalkTo");
  assert.equal(provider.oauth.getApiKey({ access: "a", refresh: "r", expires: 1 }), "a");
  assert.deepEqual([...pi.tools.keys()], ["talkto_follow", "talkto_unfollow"]);
  assert.match(pi.tools.get("talkto_follow").description, /this Pi session/);
  assert.ok(pi.commands.has("talkto-inbox"));
});

test("TalkTo's own tools are registered from its tool list and carry pi's stored token", async (t) => {
  const { pi, talkto } = await start(t);
  pi.signedIn = false;
  await pi.emit("session_start", { reason: "startup" });
  assert.deepEqual(pi.notices, ["TalkTo: run /login talkto to connect TalkTo's tools."]);
  assert.equal(talkto.calls.length, 0, "nothing is sent without a sign-in");
  await pi.emit("before_agent_start");
  assert.equal(pi.notices.length, 1, "the person is told once");

  pi.signedIn = true;
  await pi.emit("agent_start");
  assert.ok(!pi.tools.has("talkto_get_context"), "too late: the turn already has its tools");
  await pi.emit("before_agent_start");
  assert.ok(pi.tools.has("talkto_get_context"));
  assert.ok(pi.tools.has("talkto_send_message"));
  const sentReply = await pi.tools
    .get("talkto_send_message")
    .execute("call-2", { serverId: server, participantId: me, body: "hi" });
  assert.deepEqual(sentReply.content, [{ type: "text", text: '{"ok":"send_message"}' }]);
  const call = talkto.calls.at(-1);
  assert.equal(call.token, "Bearer live-token");
  assert.equal(call.params.name, "send_message");
  assert.deepEqual(call.params.arguments, { serverId: server, participantId: me, body: "hi" });
});

test("queued messages arrive as one follow-up turn once pi is idle; urgent ones are steered in", async (t) => {
  const { pi, talkto, stateDir, advance } = await start(t);
  await pi.emit("session_start", { reason: "startup" });
  talkto.updates.push(page([], "cp-start"));
  const answer = await follow(pi);
  assert.match(answer.content[0].text, /^Following participant/);
  const started = talkto.calls.findLast((call) => call.params.name === "get_updates");
  assert.equal(
    started.params.arguments.participantId,
    me,
    "the follow names the agent's own participant",
  );
  assert.deepEqual(started.params.arguments.channelIds, [general], "General is always included");
  assert.match(answer.content[0].text, /General is always watched/);

  pi.idle = false;
  talkto.updates.push(
    page(
      [message(), message({ conversationId: direct, priority: "urgent", body: "stop the deploy" })],
      "cp-1",
    ),
  );
  await pi.emit("agent_start");
  await advance(0);
  const poll = talkto.calls.findLast((call) => call.params.name === "get_updates");
  assert.equal(poll.params.arguments.waitSeconds, 50, "a running turn waits on the server");
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].deliverAs, "steer");
  assert.match(pi.sent[0].text, /stop the deploy/);
  await pi.show(pi.sent[0].text);

  const saved = JSON.parse(await readFile(join(stateDir, "session-1.json"), "utf8"));
  assert.equal(saved.follows[0].pending.length, 1, "the normal message waits");
  assert.equal((await stat(join(stateDir, "session-1.json"))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(saved), /live-token/, "no credential in the state file");

  pi.idle = true;
  await pi.emit("agent_settled");
  await advance(2000);
  const notice = pi.sent.at(-1);
  assert.equal(notice.deliverAs, "followUp");
  assert.match(notice.text, /hello/);
  assert.doesNotMatch(notice.text, /stop the deploy/, "an urgent message is not repeated");
  await pi.show(notice.text);
  await settle();
  const after = JSON.parse(await readFile(join(stateDir, "session-1.json"), "utf8"));
  assert.equal(after.follows[0].pending.length, 0);
});

/** The polls a fake TalkTo answered, in order. */
const pollsOf = (talkto) =>
  talkto.calls.filter(
    (call) => call.params.name === "get_updates" && call.params.arguments.mode === "poll",
  );

/** Five idle minutes, ten minutes into a session that never runs a turn; the polls they made. */
const idleMinutes = async (talkto, advance) => {
  for (let second = 0; second < 10 * 60; second += 1) await advance(1000);
  const before = pollsOf(talkto).length;
  for (let second = 0; second < 5 * 60; second += 1) await advance(1000);
  return pollsOf(talkto).slice(before);
};

test("an idle session keeps waiting on TalkTo, and a message sent to it starts a turn", async (t) => {
  const { pi, talkto, advance } = await start(t);
  talkto.hold = true;
  await pi.emit("session_start", { reason: "startup" });
  await follow(pi);
  // No turn ever runs. Past the ten minutes that once ended the waits, every check still waits,
  // 50 seconds each: about one call a minute, where 0.3.3 made three and 0.3.2 four.
  // TalkTo holds each 50 seconds and the next starts within a second, and the clock moves only once
  // a save is written (`settle`): 5 or 6 starts in 5 minutes, 7 at the most.
  const idle = await idleMinutes(talkto, advance);
  assert.ok(idle.length >= 5 && idle.length <= 7, `${idle.length} checks in 5 idle minutes`);
  assert.ok(idle.every((call) => call.params.arguments.waitSeconds === 50));
  assert.equal(pi.sent.length, 0);

  // A message ends the wait it arrives in, so the idle agent's turn starts within seconds.
  talkto.updates.push(page([message({ conversationId: direct, body: "are you there?" })], "cp-9"));
  for (let second = 0; second < 5; second += 1) await advance(1000);
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].deliverAs, "followUp", "a turn of its own");
  assert.match(pi.sent[0].text, /are you there\?/);
});

test("a TalkTo that refuses the long wait gets 20-second waits, and idle delivery works the same", async (t) => {
  const { pi, talkto, advance } = await start(t);
  talkto.hold = true;
  talkto.pluginWait = 20;
  await pi.emit("session_start", { reason: "startup" });
  await follow(pi);
  const idle = await idleMinutes(talkto, advance);
  assert.ok(idle.length >= 13 && idle.length <= 16, `${idle.length} checks in 5 idle minutes`);
  assert.ok(idle.every((call) => call.params.arguments.waitSeconds === 20));
  const long = pollsOf(talkto).filter((call) => call.params.arguments.waitSeconds === 50);
  assert.equal(long.length, 1, "the long wait is asked for once");

  talkto.updates.push(page([message({ conversationId: direct, body: "are you there?" })], "cp-9"));
  for (let second = 0; second < 5; second += 1) await advance(1000);
  assert.equal(pi.sent.length, 1);
  assert.match(pi.sent[0].text, /are you there\?/);
});

test("an urgent message the agent read with get_updates in the turn gets no follow-up turn", async (t) => {
  const { pi, talkto, advance } = await start(t);
  await pi.emit("session_start", { reason: "startup" });
  talkto.updates.push(page([], "cp-start"));
  await follow(pi);

  pi.idle = false;
  const urgent = message({ conversationId: direct, priority: "urgent", body: "stop the deploy" });
  talkto.updates.push(page([urgent], "cp-1"));
  await pi.emit("agent_start");
  await advance(0);
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].deliverAs, "steer");
  // pi never shows the steered row before the turn ends, but the agent reads the message itself.
  talkto.updates.push(page([urgent], "cp-agent"));
  await pi.tools.get("talkto_get_updates").execute("call-2", {
    serverId: server,
    participantId: me,
    mode: "poll",
    checkpoint: "cp-start",
  });

  pi.idle = true;
  await pi.emit("agent_settled");
  await advance(2000);
  assert.equal(pi.sent.length, 1, "nothing more is sent");
  for (const sent of pi.sent) assert.doesNotMatch(sent.text, /may not have read it/);
});

test("a notice pi never shows stays queued, and a restart restores the follow", async (t) => {
  const { pi, talkto, stateDir, advance } = await start(t);
  await pi.emit("session_start", { reason: "startup" });
  await follow(pi);
  talkto.updates.push(page([message({ body: "kept" })], "cp-2"));
  await advance(15000);
  await advance(2000);
  assert.match(pi.sent.at(-1).text, /kept/);
  await advance(confirmMillis);
  const saved = JSON.parse(await readFile(join(stateDir, "session-1.json"), "utf8"));
  assert.equal(saved.follows[0].pending.length, 1, "not shown, so not cleared");

  await pi.emit("session_shutdown", { reason: "quit" });
  const restarted = fakePi();
  extension({ mcpUrl, fetch: talkto.fetch, now: () => Date.now(), stateDir, settings })(restarted);
  await restarted.emit("session_start", { reason: "resume" });
  await restarted.commands.get("talkto-inbox").handler("", restarted.ctx());
  assert.match(restarted.notices.at(-1), /1 queued/);
});

test("print mode has nobody to deliver to: the tools work, the follow does not start", async (t) => {
  const { pi } = await start(t);
  pi.mode = "print";
  await pi.emit("session_start", { reason: "startup" });
  assert.ok(pi.tools.has("talkto_get_context"));
  await assert.rejects(follow(pi), /only in an interactive Pi session/);
});

test("print and JSON runs start no poll or timer that could keep pi from exiting", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "talkto-pi-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const talkto = fakeTalkTo();
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const setPoll = t.mock.method(globalThis, "setInterval");
  for (const mode of ["print", "json"]) {
    const pi = fakePi();
    pi.mode = mode;
    extension({ mcpUrl, fetch: talkto.fetch, now: () => Date.now(), stateDir, settings })(pi);
    await pi.emit("session_start", { reason: "startup" });
    await pi.emit("before_agent_start");
    await pi.emit("agent_start");
    await pi.tools.get("talkto_get_context").execute("call-1", {});
    await pi.emit("agent_settled");
    assert.equal(setPoll.mock.callCount(), 0, `${mode}: no poll`);
    assert.equal(setTimer.mock.callCount(), 0, `${mode}: no timer`);
  }

  const interactive = fakePi();
  extension({ mcpUrl, fetch: talkto.fetch, now: () => Date.now(), stateDir, settings })(
    interactive,
  );
  await interactive.emit("session_start", { reason: "startup" });
  assert.equal(setPoll.mock.callCount(), 1, "the check above can see a poll");
  await interactive.emit("session_shutdown", { reason: "quit" });
});

const issuer = "https://auth.talkto.test";
/** TalkTo's authorization server; the code exchange answers `access`, a refresh answers a2. */
const fakeAuthServer = (access = "a1") => {
  const forms = [];
  const routes = {
    "https://talkto.test/.well-known/oauth-protected-resource/mcp": () =>
      json(200, { resource: mcpUrl, authorization_servers: [issuer] }),
    [`${issuer}/.well-known/oauth-authorization-server`]: () =>
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
      }),
    [`${issuer}/register`]: () => json(201, { client_id: "client-1" }),
    [`${issuer}/token`]: (init) => {
      const form = new URLSearchParams(init.body);
      forms.push(form);
      return form.get("grant_type") === "authorization_code"
        ? json(200, { access_token: access, refresh_token: "r1", expires_in: 600 })
        : json(200, { access_token: "a2", refresh_token: "r2", expires_in: 600 });
    },
  };
  return { forms, fetch: async (url, init) => routes[url](init) };
};
/** The browser: TalkTo's authorization server redirects to the loopback address. */
const browser = (opened = []) => ({
  onAuth: ({ url }) => {
    const authorize = new URL(url);
    opened.push(authorize);
    const back = new URL(authorize.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "code-1");
    back.searchParams.set("state", authorize.searchParams.get("state"));
    fetch(back).catch(() => undefined);
  },
});

test("browser sign-in: discovery, a loopback answer, and renewal with what pi stored", async () => {
  const auth = fakeAuthServer();
  const deps = { mcpUrl, fetch: auth.fetch, now: () => 5000 };
  const opened = [];
  const credential = await login(deps, browser(opened));
  assert.equal(opened[0].searchParams.get("resource"), mcpUrl);
  assert.match(opened[0].searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.deepEqual(credential, {
    access: "a1",
    refresh: "r1",
    expires: 605000,
    clientId: "client-1",
    tokenEndpoint: `${issuer}/token`,
    resource: mcpUrl,
  });
  assert.equal(auth.forms[0].get("code"), "code-1");

  const renewed = await renew(deps, credential);
  assert.equal(renewed.access, "a2");
  assert.equal(renewed.refresh, "r2");
  assert.equal(auth.forms[1].get("refresh_token"), "r1");
  await assert.rejects(
    renew(deps, { access: "x", refresh: "y", expires: 0 }),
    /run \/login talkto again/,
  );
});

/** An extension whose sign-in and TalkTo both answer; pi has stored no sign-in yet. */
const signedOut = async (t, mcpFetch) => {
  const stateDir = await mkdtemp(join(tmpdir(), "talkto-pi-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const auth = fakeAuthServer("live-token");
  const both = (url, init) => (url === mcpUrl ? mcpFetch(url, init) : auth.fetch(url, init));
  const pi = fakePi();
  pi.signedIn = false;
  extension({ mcpUrl, fetch: both, now: () => Date.now(), stateDir, settings })(pi);
  await pi.emit("session_start", { reason: "startup" });
  t.after(() => pi.emit("session_shutdown", { reason: "quit" }));
  return pi;
};

test("/login talkto loads TalkTo's tools into the running session at once", async (t) => {
  const talkto = fakeTalkTo();
  const pi = await signedOut(t, talkto.fetch);
  assert.deepEqual([...pi.tools.keys()], ["talkto_follow", "talkto_unfollow"]);

  const credential = await pi.providers.get("talkto").oauth.login(browser());
  assert.equal(credential.access, "live-token");
  assert.ok(pi.tools.has("talkto_get_context"), "no restart and no extra turn needed");
  assert.ok(pi.tools.has("talkto_send_message"));
  assert.equal(
    talkto.calls.at(-1).token,
    "Bearer live-token",
    "the new token, before pi stores it",
  );
});

test("a sign-in whose tool list fails still succeeds, says so, and loads them before the next turn", async (t) => {
  const talkto = fakeTalkTo();
  let down = true;
  const pi = await signedOut(t, (url, init) =>
    down ? Promise.reject(new Error("offline")) : talkto.fetch(url, init),
  );

  const credential = await pi.providers.get("talkto").oauth.login(browser());
  assert.equal(credential.access, "live-token");
  assert.ok(!pi.tools.has("talkto_get_context"));
  assert.match(pi.notices.at(-1), /tries again before your next prompt/);

  down = false;
  pi.signedIn = true;
  await pi.emit("before_agent_start");
  assert.ok(pi.tools.has("talkto_get_context"));
});
