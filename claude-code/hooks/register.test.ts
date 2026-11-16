// The plugin wired to the engine, under `claude plugin test`: the follow tool,
// polling through the session's own MCP connection, a queued turn once idle,
// and an urgent row into a running turn; in a terminal session and in a T3
// Code thread, and nothing in a headless one.
import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { version } from "./version.ts";

const server = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const peer = "33333333-3333-4333-8333-333333333333";
const chat = "55555555-5555-4555-8555-555555555555";
const general = "44444444-4444-4444-8444-444444444444";
/** A T3 thread ID that is not a UUID, as T3 gives an MCP-launched thread. */
const thread = `mcp:launch:${"a".repeat(64)}`;
const t3Env = { CLAUDE_CODE_ENTRYPOINT: "t3-code", T3CODE_THREAD_ID: thread };

/** One message as TalkTo's get_updates returns it. */
interface Incoming {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly priority?: "urgent";
}
const page = (messages: ReadonlyArray<Incoming>, checkpoint: string) => ({
  isError: false,
  content: [],
  structuredContent: {
    data: { messages, checkpoint, nextCursor: null },
    included: {
      participants: [{ id: peer, name: "planner", agentType: "codex" }],
      conversations: [{ id: chat, kind: "direct", participantIds: [me, peer] }],
    },
    meta: {},
  },
});
/** TalkTo's get_context answer: the server and its General channel. */
const context = {
  isError: false,
  content: [],
  structuredContent: {
    data: { server: { id: server, generalConversationId: general } },
    included: { participants: [], conversations: [] },
    meta: {},
  },
};
const incoming = (id: string, body: string) => ({
  id,
  conversationId: chat,
  senderId: peer,
  body,
  createdAt: "2026-11-11T10:00:00.000Z",
});
const urgent = (id: string, body: string) => ({
  ...incoming(id, body),
  priority: "urgent" as const,
});

/** What the engine beneath the plugin holds for one test. */
interface Rig {
  /** get_updates answers in order; an Error makes the call fail, as a refused answer does. */
  readonly answers: (ReturnType<typeof page> | Error)[];
  /** get_context's answer; `context` when absent. */
  readonly context?: unknown;
  readonly sessionId?: string;
  readonly registered?: Promise<void>;
  /** The session's tool names, which the test can change: T3 adds its server after start. */
  readonly tools?: string[];
  /** The plugin's store, which the test can read and change between steps. */
  readonly store?: Map<string, unknown>;
}

/**
 * The engine beneath the plugin: TalkTo's get_updates answers in order, get_context's apart, and
 * what the plugin submits and registers.
 */
const engine = (on: On, rig: Rig) => {
  const calls: { server: string; tool: string; args: unknown }[] = [];
  const contexts: unknown[] = [];
  const submitted: string[] = [];
  const descriptions: string[] = [];
  const tools = rig.tools ?? [];
  const store = rig.store ?? new Map<string, unknown>();
  on("mcp.connect", () => ({
    value: { isConnected: true, server: "plugin:talkto-plugin:talkto" },
  }));
  on("mcp.call", (_$, e) => {
    if (e.tool === "get_context") {
      contexts.push(e.args);
      return { value: rig.context ?? context };
    }
    calls.push(e);
    const answer = rig.answers.shift() ?? page([], "cp-n");
    // `deny` rejects the plugin's $.mcp.call, as Claude Code does when it refuses an answer.
    return answer instanceof Error ? { deny: answer.message } : { value: answer };
  });
  on("prompt.submit", (_$, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  on("tool.register", async (_$, e) => {
    await (rig.registered ?? Promise.resolve());
    descriptions.push(`${e.name}: ${e.description}`);
    return { value: { tool: `mcp__talkto-plugin__${e.name}` } };
  });
  on("tool.list", () => ({
    value: tools.map((name) => ({ name, description: "", mcp: true })),
  }));
  on("store.get", (_$, e) => ({ value: store.get(e.key) }));
  on("store.set", (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)));
    return { value: undefined };
  });
  on("store.delete", (_$, e) => {
    store.delete(e.key);
    return { value: undefined };
  });
  on("store.keys", () => ({ value: [...store.keys()] }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: rig.sessionId ?? "session-1" }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.status", () => ({ value: undefined }));
  return { calls, contexts, submitted, descriptions, store };
};

const complete = { reason: "answer", answer: "done", durationMs: 10, isAborted: false } as const;
/** T3's own MCP server, as a thread's Claude has it once T3 has added it. */
const t3Tools = ["mcp__t3-code__t3_thread_send", "mcp__t3-code__t3_thread_read"];
const savedFollow = (checkpoint: string) => ({
  serverId: server,
  participantId: me,
  channelIds: [general],
  directChats: "own",
  checkpoint,
  pending: [],
  dropped: 0,
});
const record = (checkpoint: string, lease: { holder: string; aliveAt: number } | null = null) =>
  lease === null
    ? { version: 1, follows: [savedFollow(checkpoint)], notes: [] }
    : { version: 1, follows: [savedFollow(checkpoint)], notes: [], lease };
const holderOf = (store: Map<string, unknown>) =>
  JSON.stringify(store.get(`t3:${thread}`) ?? null).match(/"holder":"([^"]+)"/)?.[1] ?? null;

test("follow, poll through the session's MCP connection, queue while busy, deliver when idle", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const session = mock.session(on);
  const { calls, contexts, submitted, descriptions } = engine(on, {
    answers: [
      page([], "cp-0"),
      page(
        [incoming("m1", "can you review the schema?"), urgent("m2", "stop: wrong database")],
        "cp-1",
      ),
    ],
  });

  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  expect(descriptions[0]).toMatch(
    /^follow: Deliver your TalkTo messages into this Claude Code session\./,
  );
  const followed = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(String(followed.result)).toMatch(/^Following participant/);
  expect(String(followed.result)).not.toMatch(/T3/);
  expect(String(followed.result)).toMatch(/General is always included/);
  expect(contexts).toEqual([{ serverId: server }]);
  expect(calls[0]).toEqual({
    server: "plugin:talkto-plugin:talkto",
    tool: "get_updates",
    args: {
      serverId: server,
      participantId: me,
      mode: "start",
      channelIds: [general],
      directChats: "own",
      startAt: "now",
      limit: 50,
      plugin: `claude-code/${version}`,
    },
  });

  await $.turn.start({ text: "work", turnId: "t1" });
  await clock.advance(15_000);
  expect(calls[1]?.tool).toBe("get_updates");
  expect(submitted).toEqual([]);
  const rows = session.appended();
  expect(rows.length).toBe(1);
  expect(JSON.stringify(rows[0]?.message.content)).toMatch(/stop: wrong database/);
  expect(JSON.stringify(rows[0]?.message.content)).not.toMatch(/review the schema/);

  await $.turn.complete({ turnId: "t1", ...complete });
  await clock.advance(2_000);
  expect(submitted.length).toBe(1);
  expect(submitted[0]).toMatch(/can you review the schema\?/);
  expect(submitted[0]).not.toMatch(/stop: wrong database/);
});

test("a T3 Code thread follows and delivers as the thread once T3's server is there, and says when nothing can wake it", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, t3Env);
  const session = mock.session(on);
  const tools: string[] = [];
  const { submitted, descriptions, store } = engine(on, {
    answers: [
      page([], "cp-0"),
      page([urgent("m2", "stop: wrong database")], "cp-1"),
      page([incoming("m1", "can you review the schema?")], "cp-2"),
    ],
    tools,
  });

  // T3 runs the thread's Claude through the Agent SDK: not interactive, no surface.
  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  expect(descriptions[0]).toMatch(
    /^follow: Deliver your TalkTo messages into this T3 Code thread\./,
  );
  // T3 adds its own server only after Claude has started: until then the plugin is starting.
  const early = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(early.deny).toBe("talkto-plugin is still starting; try again in a moment.");
  tools.push(...t3Tools);
  await clock.advance(2_000);

  const followed = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(String(followed.result)).toMatch(/^Following participant/);
  expect(String(followed.result)).toMatch(/T3 releases a thread's Claude after 30 minutes/);
  expect(String(followed.result)).toMatch(/after the person next writes in this thread/);
  expect(String(followed.result)).toMatch(/Tell your person this/);
  expect(holderOf(store)).toMatch(/^session-1:/);

  await $.turn.start({ text: "work", turnId: "t1" });
  await clock.advance(15_000);
  expect(JSON.stringify(session.appended()[0]?.message.content)).toMatch(/stop: wrong database/);
  await $.turn.complete({ turnId: "t1", ...complete });
  await clock.advance(20_000);
  expect(submitted.length).toBe(1);
  expect(submitted[0]).toMatch(/can you review the schema\?/);
});

test("the Claude T3 starts again for a thread restores the thread's follow and polls at once", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, t3Env);
  // The released process's lease, last renewed two minutes ago.
  const store = new Map<string, unknown>([
    [`t3:${thread}`, record("cp-saved", { holder: "session-1:old", aliveAt: 880_000 })],
  ]);
  const { calls, submitted } = engine(on, {
    answers: [page([incoming("m1", "sent while T3 had released the thread")], "cp-1")],
    tools: [...t3Tools],
    store,
  });

  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(1_000);
  expect(calls[0]?.args).toMatchObject({ mode: "poll", checkpoint: "cp-saved" });
  expect(holderOf(store)).not.toBe("session-1:old");
  await clock.advance(5_000);
  expect(submitted.length).toBe(1);
  expect(submitted[0]).toMatch(/sent while T3 had released the thread/);
});

test("a turn that starts while the session is still starting is not run over, and gets urgent messages", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, t3Env);
  const session = mock.session(on);
  let release = () => {};
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { submitted } = engine(on, {
    answers: [
      page(
        [incoming("m1", "sent while the person's turn runs"), urgent("m2", "stop: wrong database")],
        "cp-1",
      ),
    ],
    sessionId: "session-3",
    registered,
    tools: [...t3Tools],
    store: new Map<string, unknown>([[`t3:${thread}`, record("cp-saved")]]),
  });

  // T3 starts the thread's Claude with the person's message: the turn begins before the
  // plugin has registered its tools.
  const started = $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await $.turn.start({ text: "the person's message", turnId: "t1" });
  release();
  await started;
  await clock.advance(20_000);
  expect(submitted).toEqual([]);
  expect(JSON.stringify(session.appended()[0]?.message.content)).toMatch(/stop: wrong database/);
  await $.turn.complete({ turnId: "t1", ...complete });
  await clock.advance(5_000);
  expect(submitted.length).toBe(1);
  expect(submitted[0]).toMatch(/sent while the person's turn runs/);
  expect(submitted[0]).not.toMatch(/stop: wrong database/);
});

test("T3's environment without T3's own server (a helper run, a script) never touches the thread", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, t3Env);
  const saved = record("cp-saved", { holder: "session-1:thread", aliveAt: 999_000 });
  const store = new Map<string, unknown>([[`t3:${thread}`, saved]]);
  const { calls, submitted } = engine(on, {
    answers: [page([incoming("m1", "for the thread")], "cp-1")],
    tools: [],
    store,
  });

  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(4 * 60 * 1000);
  const refused = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(refused.deny).toMatch(/not T3's own t3-code MCP server/);
  expect(calls).toEqual([]);
  expect(submitted).toEqual([]);
  expect(store.get(`t3:${thread}`)).toEqual(saved);
});

test("a second process for a live thread stands by, then takes over once the holder stops", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, t3Env);
  const store = new Map<string, unknown>([
    [`t3:${thread}`, record("cp-saved", { holder: "session-1:other", aliveAt: 1_000_000 })],
  ]);
  const { calls, submitted } = engine(on, {
    answers: [page([incoming("m1", "waited for the takeover")], "cp-1")],
    tools: [...t3Tools],
    store,
  });

  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(2_000);
  const refused = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(refused.deny).toMatch(/Another Claude process for this T3 thread/);
  // The other holder renews for a while: this process stays out.
  for (const at of [1_020_000, 1_040_000]) {
    store.set(`t3:${thread}`, record("cp-saved", { holder: "session-1:other", aliveAt: at }));
    await clock.advance(20_000);
  }
  expect(calls).toEqual([]);
  // The holder stops renewing: once its lease is a minute old, this process takes over.
  await clock.advance(80_000);
  expect(holderOf(store)).not.toBe("session-1:other");
  expect(calls[0]?.args).toMatchObject({ mode: "poll", checkpoint: "cp-saved" });
  await clock.advance(5_000);
  expect(submitted.length).toBe(1);
});

test("a holder that finds another live holder stops delivering", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, t3Env);
  const store = new Map<string, unknown>([[`t3:${thread}`, record("cp-saved")]]);
  const { calls, submitted } = engine(on, {
    answers: [page([], "cp-1"), page([incoming("m1", "for the new holder")], "cp-2")],
    tools: [...t3Tools],
    store,
  });

  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(2_000);
  expect(calls.length).toBe(1);
  // Another process takes the lease (this one looked dead to it); its write is fresh.
  store.set(`t3:${thread}`, record("cp-1", { holder: "session-1:other", aliveAt: 1_002_000 }));
  await clock.advance(20_000);
  const polled = calls.length;
  // The other process keeps renewing its lease: this one stays out.
  for (const at of [1_022_000, 1_042_000, 1_062_000]) {
    store.set(`t3:${thread}`, record("cp-1", { holder: "session-1:other", aliveAt: at }));
    await clock.advance(20_000);
  }
  expect(calls.length).toBe(polled);
  expect(submitted).toEqual([]);
  expect(holderOf(store)).toBe("session-1:other");
});

test("a thread's Claude that ends frees its lease at once and keeps the follow", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, t3Env);
  const store = new Map<string, unknown>([[`t3:${thread}`, record("cp-saved")]]);
  const { calls } = engine(on, { answers: [page([], "cp-1")], tools: [...t3Tools], store });
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));

  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(2_000);
  expect(holderOf(store)).toMatch(/^session-1:/);
  await $.session.end({ reason: "other", sessionId: "session-1" });
  const saved = JSON.stringify(store.get(`t3:${thread}`));
  // Stale already, so the next process for the thread takes over without waiting.
  expect(Number(saved.match(/"aliveAt":(-?\d+)/)?.[1])).toBeLessThan(1_002_000 - 60_000);
  expect(saved).toMatch(/"checkpoint":"cp-1"/);
  const polled = calls.length;
  await clock.advance(60_000);
  expect(calls.length).toBe(polled);
});

test("thread records nobody renewed for a month are removed", async ($, on) => {
  const clock = mock.clock(on, { now: 40 * 24 * 60 * 60 * 1000 });
  mock.env(on, t3Env);
  const store = new Map<string, unknown>([
    ["t3:gone", record("cp-old", { holder: "s:old", aliveAt: 1_000 })],
    ["t3:recent", record("cp-recent", { holder: "s:new", aliveAt: 39 * 24 * 60 * 60 * 1000 })],
    ["session:terminal", record("cp-terminal")],
  ]);
  engine(on, { answers: [], tools: [...t3Tools], store });
  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(2_000);
  expect([...store.keys()].sort()).toEqual(["session:terminal", `t3:${thread}`, "t3:recent"]);
});

test("after a reload or compaction a terminal session resumes its stored follow and polls at once", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const store = new Map<string, unknown>([["session:session-1", record("cp-saved")]]);
  const { calls, submitted } = engine(on, {
    answers: [page([incoming("m1", "sent while reloading")], "cp-1")],
    store,
  });
  // A reload runs register and session.start again; only $.store carries the follow over.
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(0);
  expect(calls[0]?.args).toMatchObject({ mode: "poll", checkpoint: "cp-saved" });
  await clock.advance(2_000);
  expect(submitted.join("\n")).toMatch(/sent while reloading/);
});

test("a stale TalkTo connection is named at follow, and a refused answer restarts and says to reconnect", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const listed = "mcp__plugin_talkto-plugin_talkto__";
  const { calls, submitted } = engine(on, {
    answers: [
      page([], "cp-0"),
      new Error(
        "MCP error -32602: Structured content does not match the tool's output schema: data/data/messages/0 must NOT have additional properties",
      ),
      page([], "cp-restarted"),
      page([incoming("m1", "after the restart")], "cp-2"),
    ],
    context: {
      ...context,
      structuredContent: {
        ...context.structuredContent,
        data: { ...context.structuredContent.data, capabilities: ["transfers"] },
      },
    },
    tools: [`${listed}get_updates`, `${listed}send_message`, `${listed}share_file`],
  });

  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  const followed = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(String(followed.result)).toMatch(
    /older than the server: it lacks prepare_transfer, complete_transfer, fetch_transfer/,
  );
  expect(String(followed.result)).toMatch(
    /run \/mcp, select plugin:talkto-plugin:talkto \(or the TalkTo server they added\) and choose Reconnect/,
  );

  // The follow just started, so polls wait on TalkTo and chain one after another.
  await clock.advance(15_000);
  expect(calls[1]?.args).toMatchObject({ mode: "poll", checkpoint: "cp-0" });
  expect(calls[2]?.args).toMatchObject({ mode: "start", startAt: "now" });
  expect(calls[3]?.args).toMatchObject({ mode: "poll", checkpoint: "cp-restarted" });
  expect(submitted[0]).toMatch(/refused TalkTo's answer for participant/);
  expect(submitted[0]).toMatch(/choose Reconnect/);
  expect(submitted.join("\n")).toMatch(/after the restart/);
});

for (const [name, env] of [
  ["claude -p", {}],
  ["an Agent SDK app", { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }],
  ["a Claude T3 runs for no thread", { CLAUDE_CODE_ENTRYPOINT: "t3-code" }],
  ["a claude -p run inside a T3 thread", { ...t3Env, CLAUDECODE: "1" }],
  ["a child session inside a T3 thread", { ...t3Env, CLAUDE_CODE_CHILD_SESSION: "1" }],
  ["another entrypoint beside a thread ID", { ...t3Env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
] as const)
  test(`${name} never follows or delivers, and says why`, async ($, on) => {
    mock.clock(on);
    mock.env(on, env);
    const { calls, descriptions } = engine(on, { answers: [], tools: [...t3Tools] });
    await $.session.start({ cwd: "/", surface: null, isInteractive: false });
    expect(descriptions).toEqual([]);
    const refused = await $.tool.call({
      tool: "mcp__talkto-plugin__follow",
      serverId: server,
      participantId: me,
    });
    expect(refused.deny).toMatch(/may end with its turn/);
    expect(refused.deny).toMatch(/get_updates/);
    expect(calls).toEqual([]);
  });
