// The plugin wired to the engine, under `claude plugin test`: the follow tool,
// polling through the session's own MCP connection, a queued turn once idle,
// and an urgent row into a running turn.
import { expect, mock, test } from "claude-code/testing";

const server = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const peer = "33333333-3333-4333-8333-333333333333";
const chat = "55555555-5555-4555-8555-555555555555";

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

test("follow, poll through the session's MCP connection, queue while busy, deliver when idle", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.store(on);
  const session = mock.session(on);
  const calls: { server: string; tool: string; args: unknown }[] = [];
  const answers = [
    page([], "cp-0"),
    page(
      [incoming("m1", "can you review the schema?"), urgent("m2", "stop: wrong database")],
      "cp-1",
    ),
  ];
  const submitted: string[] = [];
  on("mcp.connect", () => ({
    value: { isConnected: true, server: "plugin:talkto-plugin:talkto" },
  }));
  on("mcp.call", (_$, e) => {
    calls.push(e);
    return { value: answers.shift() ?? page([], "cp-n") };
  });
  on("prompt.submit", (_$, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  on("tool.register", (_$, e) => ({ value: { tool: `mcp__talkto-plugin__${e.name}` } }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: "session-1" }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.status", () => ({ value: undefined }));

  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  const followed = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(String(followed.result)).toMatch(/^Following participant/);
  expect(calls[0]).toEqual({
    server: "plugin:talkto-plugin:talkto",
    tool: "get_updates",
    args: {
      serverId: server,
      participantId: me,
      mode: "start",
      channelIds: [],
      directChats: "own",
      startAt: "now",
      limit: 50,
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

  await $.turn.complete({
    turnId: "t1",
    reason: "answer",
    answer: "done",
    durationMs: 10,
    isAborted: false,
  });
  await clock.advance(2_000);
  expect(submitted.length).toBe(1);
  expect(submitted[0]).toMatch(/can you review the schema\?/);
  expect(submitted[0]).not.toMatch(/stop: wrong database/);
});

test("a non-interactive session never follows or delivers", async ($, on) => {
  mock.clock(on);
  mock.store(on);
  on("tool.register", (_$, e) => ({ value: { tool: `mcp__talkto-plugin__${e.name}` } }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  const refused = await $.tool.call({
    tool: "mcp__talkto-plugin__follow",
    serverId: server,
    participantId: me,
  });
  expect(refused.deny).toMatch(/interactive session/);
});
