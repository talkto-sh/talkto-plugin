// talkto-plugin for OpenCode 2 against a fake OpenCode context and a fake
// TalkTo: the integration sign-in, TalkTo's tools, and delivery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plugin } from "../plugin.ts";
import { authorize, refresh } from "../signin.ts";

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

/** What the fake TalkTo answers get_context with: the server and its General channel. */
const context = JSON.stringify({
  data: { server: { id: server, generalConversationId: general } },
});

const fakeTalkTo = () => {
  const talkto = {
    calls: [],
    updates: [],
    fetch: async (_url, init) => {
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
            ],
          },
        });
      const result =
        body.params.name === "get_updates"
          ? (talkto.updates.shift() ?? page([], `cp-${sequence}`))
          : body.params.name === "get_context"
            ? { isError: false, content: [{ type: "text", text: context }] }
            : { isError: false, content: [{ type: "text", text: `{"ok":"${body.params.name}"}` }] };
      return json(200, { jsonrpc: "2.0", id: body.id, result });
    },
  };
  return talkto;
};

/** An OpenCode 2 context: transforms applied on demand, events pushed by the test. */
const fakeOpenCode = () => {
  const waiting = [];
  const pending = [];
  const opencode = {
    connected: true,
    storage: new Map(),
    prompts: [],
    integrationEditors: [],
    toolTransforms: [],
    reloads: 0,
    rows: 0,
    /** The tools a request would see now. */
    tools: () => {
      const tools = new Map();
      for (const transform of opencode.toolTransforms)
        transform({ add: (tool) => tools.set(tool.name, tool) });
      return tools;
    },
    push: (event) => {
      const next = waiting.shift();
      if (next !== undefined) next({ value: event, done: false });
      else pending.push(event);
    },
    ctx: {
      integration: {
        transform: async (callback) => {
          const editor = { names: {}, methods: [] };
          callback({
            update: (id, update) => {
              const ref = { id, name: id };
              update(ref);
              editor.names[id] = ref.name;
            },
            method: { update: (input) => editor.methods.push(input) },
          });
          opencode.integrationEditors.push(editor);
          return { dispose: async () => undefined };
        },
        connection: {
          active: async (id) =>
            id === "talkto" && opencode.connected ? { integrationID: id } : undefined,
          resolve: async () => ({ type: "oauth", access: "live-token" }),
        },
      },
      tool: {
        transform: async (callback) => {
          opencode.toolTransforms.push(callback);
          return { dispose: async () => undefined };
        },
        reload: async () => {
          opencode.reloads += 1;
        },
      },
      session: {
        prompt: async (input) => {
          opencode.rows += 1;
          opencode.prompts.push(input);
          return { id: `msg_${opencode.rows}` };
        },
      },
      event: {
        subscribe: ({ signal }) => ({
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (signal.aborted) return Promise.resolve({ value: undefined, done: true });
              const event = pending.shift();
              if (event !== undefined) return Promise.resolve({ value: event, done: false });
              return new Promise((resolve) => {
                waiting.push(resolve);
                signal.addEventListener("abort", () => resolve({ value: undefined, done: true }));
              });
            },
          }),
        }),
      },
      storage: {
        get: async (key) => opencode.storage.get(key),
        set: async (key, value) => void opencode.storage.set(key, value),
        remove: async (key) => void opencode.storage.delete(key),
        scan: async ({ prefix }) => ({
          entries: [...opencode.storage]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value })),
        }),
      },
    },
  };
  return opencode;
};

const settings = { delivery: "idle", urgent: "inject", pollMillis: 15000, wait: "auto" };
const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const start = async (t, opencode = fakeOpenCode(), talkto = fakeTalkTo()) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const cleanup = await plugin({
    mcpUrl,
    fetch: talkto.fetch,
    now: () => Date.now(),
    settings,
  }).setup(opencode.ctx);
  t.after(() => cleanup?.());
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { opencode, talkto, advance, cleanup };
};
const follow = (opencode, sessionID = "ses_1") =>
  opencode
    .tools()
    .get("talkto_follow")
    .execute(
      { serverId: server, participantId: me, channelIds: [], directChats: "own" },
      { sessionID },
    );

test("setup adds the TalkTo integration with a browser sign-in and TalkTo's tools", async (t) => {
  const { opencode, talkto } = await start(t);
  const [editor] = opencode.integrationEditors;
  assert.equal(editor.names.talkto, "TalkTo");
  assert.equal(editor.methods[0].integrationID, "talkto");
  assert.deepEqual(editor.methods[0].method, {
    id: "browser",
    type: "oauth",
    label: "Sign in with your browser",
  });
  assert.equal(opencode.reloads, 1, "TalkTo's tool list was loaded and the tools reloaded");
  const tools = opencode.tools();
  assert.deepEqual([...tools.keys()], ["talkto_follow", "talkto_unfollow", "talkto_get_context"]);
  assert.match(tools.get("talkto_follow").description, /this OpenCode session/);
  const reply = await tools
    .get("talkto_get_context")
    .execute({ serverId: server }, { sessionID: "ses_1" });
  assert.equal(reply.content, context);
  assert.equal(talkto.calls.at(-1).token, "Bearer live-token");
});

test("without a connection the tools wait for sign-in and a failed call is answered as text", async (t) => {
  const opencode = fakeOpenCode();
  opencode.connected = false;
  const { talkto } = await start(t, opencode);
  assert.equal(talkto.calls.length, 0, "nothing is sent without a credential");
  const answer = await follow(opencode);
  assert.match(answer.content, /Could not reach TalkTo .*connect TalkTo in OpenCode/);
  opencode.connected = true;
  opencode.push({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  await settle();
  assert.ok(opencode.tools().has("talkto_get_context"), "tools appear once TalkTo is connected");
});

test("queued messages go in as a queued prompt once idle; urgent ones are steered and confirmed", async (t) => {
  const { opencode, talkto, advance } = await start(t);
  talkto.updates.push(page([], "cp-start"));
  const followed = (await follow(opencode)).content;
  assert.match(followed, /^Following participant/);
  assert.match(followed, /General is always included/);
  const started = talkto.calls.findLast((call) => call.params.name === "get_updates");
  assert.equal(started.params.arguments.participantId, me);
  assert.deepEqual(started.params.arguments.channelIds, [general], "General is always included");

  opencode.push({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  await settle();
  talkto.updates.push(
    page(
      [message(), message({ conversationId: direct, priority: "urgent", body: "stop the deploy" })],
      "cp-1",
    ),
  );
  await advance(0);
  const poll = talkto.calls.findLast((call) => call.params.name === "get_updates");
  assert.equal(poll.params.arguments.waitSeconds, 20);
  const steer = opencode.prompts.at(-1);
  assert.equal(steer.delivery, "steer");
  assert.equal(steer.sessionID, "ses_1");
  assert.match(steer.text, /stop the deploy/);
  opencode.push({
    type: "session.inbox.delivered",
    data: { sessionID: "ses_1", inboxID: `msg_${opencode.rows}` },
  });
  await settle();

  const saved = JSON.parse(opencode.storage.get("session:ses_1"));
  assert.equal(saved.follows[0].pending.length, 1, "the normal message waits");
  assert.doesNotMatch(opencode.storage.get("session:ses_1"), /live-token/);

  opencode.push({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
  await settle();
  await advance(2000);
  const queued = opencode.prompts.at(-1);
  assert.equal(queued.delivery, "queue");
  assert.match(queued.text, /hello/);
  assert.doesNotMatch(
    queued.text,
    /stop the deploy|arrived as your last turn ended/,
    "the delivered steer is not repeated",
  );
  assert.equal(JSON.parse(opencode.storage.get("session:ses_1")).follows[0].pending.length, 0);
});

test("an urgent row the run never read is pointed out after the turn", async (t) => {
  const { opencode, talkto, advance } = await start(t);
  await follow(opencode);
  opencode.push({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  await settle();
  talkto.updates.push(
    page([message({ conversationId: direct, priority: "urgent", body: "too late" })], "cp-2"),
  );
  await advance(0);
  assert.equal(opencode.prompts.at(-1).delivery, "steer");
  opencode.push({ type: "session.execution.interrupted", data: { sessionID: "ses_1" } });
  await settle();
  await advance(2000);
  assert.equal(opencode.prompts.at(-1).delivery, "queue");
  assert.match(opencode.prompts.at(-1).text, /arrived as your last turn ended/);
});

test("follows survive a restart: saved sessions resume their polls", async (t) => {
  const opencode = fakeOpenCode();
  const first = await start(t, opencode);
  await follow(opencode, "ses_9");
  first.cleanup();
  t.mock.timers.reset();
  const talkto = fakeTalkTo();
  const second = await start(t, opencode, talkto);
  talkto.updates.push(page([message({ body: "after restart" })], "cp-3"));
  await second.advance(15000);
  await second.advance(2000);
  const prompt = opencode.prompts.at(-1);
  assert.equal(prompt.sessionID, "ses_9");
  assert.match(prompt.text, /after restart/);
});

test("OpenCode 1.18's early loader gets nothing registered", async () => {
  assert.equal(
    await plugin({ mcpUrl, fetch: async () => json(500, {}), now: () => 0, settings }).setup({}),
    undefined,
  );
});

test("browser sign-in: the loopback answer becomes a credential OpenCode stores and renews", async () => {
  const issuer = "https://auth.talkto.test";
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
    [`${issuer}/token`]: (init) =>
      new URLSearchParams(init.body).get("grant_type") === "authorization_code"
        ? json(200, { access_token: "a1", refresh_token: "r1", expires_in: 600 })
        : json(200, { access_token: "a2", expires_in: 600 }),
  };
  const deps = { mcpUrl, fetch: async (url, init) => routes[url](init), now: () => 5000 };
  const authorization = await authorize(deps);
  assert.equal(authorization.mode, "auto");
  const opened = new URL(authorization.url);
  const back = new URL(opened.searchParams.get("redirect_uri"));
  back.searchParams.set("code", "code-1");
  back.searchParams.set("state", opened.searchParams.get("state"));
  const page = await fetch(back);
  assert.match(await page.text(), /Signed in to TalkTo.*OpenCode/);
  const credential = await authorization.callback;
  assert.deepEqual(credential, {
    type: "oauth",
    methodID: "browser",
    access: "a1",
    refresh: "r1",
    expires: 605000,
    metadata: { clientId: "client-1", tokenEndpoint: `${issuer}/token`, resource: mcpUrl },
  });
  const renewed = await refresh(deps, credential);
  assert.equal(renewed.access, "a2");
  assert.equal(renewed.refresh, "r1", "a server that does not rotate keeps the refresh token");
});
