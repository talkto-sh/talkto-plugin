// The Hermes plugin is Python (Hermes loads plugins into its own Python
// process), so it carries a port of the core instead of a copy. This test
// holds the port to the core: both decode the same get_updates replies and
// must produce the same messages and byte-identical notices. It also runs the
// Hermes plugin's own Python tests, so `npm test` covers every plugin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decodeUpdates } from "../src/talkto.ts";
import {
  followEnded,
  heldSummary,
  isNewer,
  previewOf,
  queuedNotice,
  updateNotice,
  urgentNotice,
} from "../src/notice.ts";
import { hostTimings, wakeRules } from "../src/inbox.ts";
import { followDescription, followSchema } from "../src/tools.ts";

const hermes = new URL("../../hermes/", import.meta.url).pathname;
const python = process.env.PYTHON ?? "python3";
const server = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const peer = "33333333-3333-4333-8333-333333333333";
const general = "44444444-4444-4444-8444-444444444444";
const direct = "55555555-5555-4555-8555-555555555555";
const unnamed = "66666666-6666-4666-8666-666666666666";

const message = (index, fields = {}) => ({
  id: `m-${index}`,
  sequence: index,
  conversationId: general,
  senderId: peer,
  body: `hello ${index} — ünïcode`,
  createdAt: "2026-11-11T10:00:00.000Z",
  ...fields,
});
const included = {
  participants: [
    { id: peer, name: "planner", agentType: "codex" },
    { id: me, name: "builder" },
  ],
  conversations: [
    { id: general, kind: "channel", name: "general" },
    { id: direct, kind: "direct", participantIds: [me, peer] },
    { id: unnamed, kind: "direct", participantIds: [me, "77777777-7777-4777-8777-777777777777"] },
  ],
};
const page = (messages, nextCursor = null) => ({
  data: { messages, checkpoint: "cp-1", nextCursor },
  included,
  meta: {},
});
const rename = (index, fields = {}) => ({
  id: `r-${index}`,
  sequence: 1000 + index,
  participantId: peer,
  previousName: `planner-${index}`,
  name: `planner-${index + 1}`,
  renamedAt: "2026-11-15T10:00:00.000Z",
  renamedBy: { kind: "self" },
  ...fields,
});
const offer = (fields = {}) => ({
  id: "99999999-9999-4999-8999-999999999999",
  name: "rollcall — ünïcode.txt",
  kind: "file",
  bytes: 111,
  sha256: `c9f88d90${"a".repeat(56)}`,
  fileCount: null,
  expiresAt: "2026-11-17T15:00:00.000Z",
  ...fields,
});
const renamed = (messages, renames) => {
  const result = page(messages);
  result.data.renames = renames;
  return result;
};
const envelopes = [
  page([message(1), message(2, { conversationId: direct })]),
  page(
    [message(3, { conversationId: direct, priority: "urgent", body: "stop the deploy" })],
    "next",
  ),
  page([message(4, { body: "x".repeat(2500) }), message(5, { conversationId: unnamed })]),
  // Long bodies: one at the limit, then a burst that spends the notice's body budget.
  page([
    message(30, { body: "y".repeat(8000) }),
    ...Array.from({ length: 13 }, (_, index) =>
      message(31 + index, { body: `z${index}`.repeat(4000 + index * 100) }),
    ),
  ]),
  page([
    message(6, { conversationId: "88888888-8888-4888-8888-888888888888", senderId: "nobody" }),
  ]),
  page(
    Array.from({ length: 60 }, (_, index) =>
      message(100 + index, { priority: index % 7 === 0 ? "urgent" : "normal" }),
    ),
  ),
  page([]),
  // Renames are additive and read leniently: unreadable entries are skipped, never a failure.
  renamed(
    [message(8)],
    [
      rename(1),
      rename(2, { renamedBy: { kind: "person", participantId: unnamed, name: "alice" } }),
      rename(3, { participantId: me, previousName: "builder", name: "builder-macbook" }),
      rename(4, { renamedBy: { kind: "robot" } }),
      rename(5, { renamedBy: { kind: "person" } }),
      rename(6, { renamedBy: undefined }),
      rename(7, { name: 7 }),
      { id: "r-8", participantId: peer },
      "not a rename",
      null,
    ],
  ),
  renamed([], [rename(9)]),
  renamed(
    [],
    Array.from({ length: 13 }, (_, index) => rename(20 + index)),
  ),
  // File offers, and malformed ones a port must leave out the same way while keeping the message.
  page([
    message(13, { transfer: offer() }),
    message(14, { transfer: offer({ kind: "folder", name: "screens", bytes: 1, fileCount: 1 }) }),
    message(15, { transfer: offer({ kind: "folder", fileCount: 40, bytes: 9_000_000 }) }),
    message(16, { transfer: offer({ fileCount: undefined }) }),
    ...[
      offer({ sha256: "C9F88D90" }),
      offer({ kind: "archive" }),
      offer({ bytes: -1 }),
      offer({ bytes: true }),
      offer({ fileCount: "3" }),
      offer({ expiresAt: null }),
      { id: "only-an-id" },
      "not an offer",
      null,
    ].map((transfer, index) => message(17 + index, { transfer })),
  ]),
  page(
    Array.from({ length: 14 }, (_, index) =>
      message(200 + index, index % 2 === 0 ? { transfer: offer({ id: `t-${index}` }) } : {}),
    ),
  ),
  // Why each message reached the participant, and a new-channel notice shown on one line.
  page([
    message(50, { mentions: [me] }),
    message(51, { mentions: [peer, 7, null] }),
    message(52, { mentions: "not a list" }),
    message(53, {
      body: "TalkTo: planner created the channel #deploys.\nDescription: x\n  To follow it, add it.",
      notice: { kind: "channel_created", channelId: direct, channelName: "deploys" },
    }),
    message(54, { notice: "not an object" }),
    message(55, { conversationId: direct, mentions: [me] }),
  ]),
  renamed([message(10)], "not a list"),
  renamed([message(11)], []),
  // The person's wake cadence, and values a port must refuse the same way.
  ...[300, 0, -1, 1.5, "60", true, 90_000].map((wakeIntervalSeconds) => {
    const paced = page([message(7)]);
    paced.data.wakeIntervalSeconds = wakeIntervalSeconds;
    return paced;
  }),
  // The plugin's newest version, and values a port must refuse the same way.
  ...["0.4.0", "10.20.30", "0.4", "v0.4.0", 4, null, "0.4.0-beta"].map((latestPluginVersion) => {
    const versioned = page([message(12)]);
    versioned.data.latestPluginVersion = latestPluginVersion;
    return versioned;
  }),
  { error: { code: "participant_not_found", message: "gone" }, meta: {} },
  { error: {} },
  { data: { messages: [] } },
  page([{ id: "m-9", body: "no sender" }]),
  page(["not an object"]),
];
const cases = [
  ...envelopes.map((envelope, index) => ({
    envelope,
    serverId: server,
    participantId: me,
    dropped: index % 3,
    pythonOnly: false,
  })),
  // A notice with renames and nothing else, as the person's prompt carries it.
  ...[renamed([], [rename(40)]), renamed([], [rename(41, { participantId: me })])].map(
    (envelope) => ({
      envelope,
      serverId: server,
      participantId: me,
      dropped: 0,
      pythonOnly: false,
    }),
  ),
  // The core never sees a plain string: its host always hands over an MCP result.
  {
    envelope: "not an envelope",
    serverId: server,
    participantId: me,
    dropped: 0,
    pythonOnly: true,
  },
];

const typescript = (item) => {
  const reply = decodeUpdates(
    { isError: false, structuredContent: item.envelope, content: [] },
    item.participantId,
  );
  if (reply.kind === "failure") return { failure: reply.failure };
  const recipient = { serverId: item.serverId, participantId: item.participantId };
  const messages = reply.page.messages;
  return {
    page: {
      messages,
      renames: reply.page.renames,
      checkpoint: reply.page.checkpoint,
      hasMore: reply.page.hasMore,
      wakeIntervalSeconds: reply.page.wakeIntervalSeconds,
      latestPluginVersion: reply.page.latestPluginVersion,
    },
    queued: queuedNotice(recipient, messages, item.dropped, reply.page.renames),
    urgent: urgentNotice(recipient, messages),
    ended: followEnded(recipient, "participant_not_found: gone"),
  };
};

const runPython = (args, input) =>
  spawnSync(python, ["-I", ...args], { cwd: `${hermes}tests`, input, encoding: "utf8" });

test("the Hermes port decodes replies and writes notices exactly like the core", () => {
  const run = runPython(["conformance.py"], JSON.stringify(cases));
  assert.equal(run.status, 0, run.stderr);
  const ported = JSON.parse(run.stdout);
  cases.forEach((item, index) => {
    if (item.pythonOnly) return;
    assert.deepEqual(ported[index], typescript(item), `case ${index}`);
  });
  assert.deepEqual(ported.at(-1).failure.code, "unreadable");
});

/** Every plugin's update line, and version comparisons, in both languages. */
const updateCases = ["claude-code", "opencode", "pi", "hermes"].flatMap((name) =>
  [
    ["0.3.0", "0.4.0"],
    ["0.9.0", "0.10.0"],
    ["1.0.0", "0.99.99"],
    ["0.3.0", "0.3.0"],
  ].map(([version, latest]) => ({ name, version, latest })),
);

test("the Hermes port writes the update line and compares versions exactly like the core", () => {
  const run = runPython(["conformance.py", "--updates"], JSON.stringify(updateCases));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    JSON.parse(run.stdout),
    updateCases.map(({ name, version, latest }) => ({
      text: updateNotice({ name, version }, latest),
      newer: isNewer(latest, version),
    })),
  );
});

const heldCases = [
  {
    serverId: server,
    participantId: me,
    alone: true,
    tallies: [
      {
        conversationId: general,
        where: "#general",
        count: 11,
        senders: ["planner", "builder", "a", "b"],
        recent: Array.from({ length: 8 }, (_, index) => ({
          id: `m-${index}`,
          from: "planner",
          line: `ünïcode line ${index}`,
        })),
      },
      {
        conversationId: direct,
        where: "#deploys",
        count: 1,
        senders: ["builder"],
        recent: [{ id: "m-9", from: "builder", line: "" }],
      },
    ],
    bodies: ["one line", "\n\n  first  \nsecond", "x".repeat(150), "", "ü".repeat(101)],
    full: 0,
    generalInFull: false,
    batchMillis: 4 * 60_000,
  },
  {
    serverId: server,
    participantId: me,
    alone: false,
    tallies: [
      {
        conversationId: general,
        where: "#general",
        count: 1,
        senders: ["planner"],
        recent: [{ id: "m-1", from: "planner", line: "hi" }],
      },
    ],
    bodies: [],
    full: 1,
    generalInFull: true,
    batchMillis: 60_000,
  },
  {
    serverId: server,
    participantId: me,
    alone: false,
    tallies: [],
    bodies: [],
    full: 3,
    generalInFull: false,
    batchMillis: 30 * 60_000,
  },
];

test("the Hermes port summarizes held channel messages exactly like the core", () => {
  const run = runPython(["conformance.py", "--held"], JSON.stringify(heldCases));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    JSON.parse(run.stdout),
    heldCases.map((item) => ({
      summary: heldSummary(
        { serverId: item.serverId, participantId: item.participantId },
        item.tallies,
        item.alone,
      ),
      previews: item.bodies.map(previewOf),
      rules: wakeRules(item.full, item.generalInFull, item.batchMillis),
    })),
  );
});

test("the Hermes port offers the same follow tool and Hermes's timing from the core's table", () => {
  const run = runPython(["conformance.py", "--tools"], "[]");
  assert.equal(run.status, 0, run.stderr);
  const ported = JSON.parse(run.stdout);
  assert.equal(ported.description, followDescription("this Hermes session"));
  assert.deepEqual(ported.schema, JSON.parse(JSON.stringify(followSchema)));
  assert.deepEqual(ported.timing, hostTimings.hermes);
});

test("the Hermes plugin's Python tests pass", () => {
  const run = runPython(["-m", "unittest", "discover", "-s", ".", "-t", "."]);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test("renames are listed before the messages, at most ten, and old servers see no change", () => {
  const recipient = { serverId: server, participantId: me };
  const decoded = (envelope) => {
    const reply = decodeUpdates({ isError: false, structuredContent: envelope, content: [] }, me);
    assert.equal(reply.kind, "page");
    return reply.page;
  };
  const withRenames = decoded(
    renamed(
      [message(1)],
      [
        rename(1),
        rename(2, { renamedBy: { kind: "person", participantId: unnamed, name: "alice" } }),
        rename(3, { participantId: me, previousName: "builder", name: "builder-macbook" }),
      ],
    ),
  );
  const text = queuedNotice(recipient, withRenames.messages, 0, withRenames.renames);
  assert.match(
    text,
    new RegExp(
      `^TalkTo: 1 new message and 3 participant renames for your participant ${me} on server ${server}\\.`,
    ),
  );
  assert.ok(
    text.includes(
      [
        "Renamed participants (each keeps its participant ID; update the names you remember):",
        `- planner-1 is now planner-2 (renamed itself) · participantId ${peer}`,
        `- planner-2 is now planner-3 (renamed by alice) · participantId ${peer}`,
        `- builder (you) is now builder-macbook (renamed itself) · participantId ${me}`,
      ].join("\n"),
    ),
  );
  assert.ok(text.indexOf("Renamed participants") < text.indexOf("[1] #general"));

  const many = decoded(
    renamed(
      [],
      Array.from({ length: 13 }, (_, index) => rename(index)),
    ),
  );
  const capped = queuedNotice(recipient, [], 0, many.renames);
  assert.match(capped, /^TalkTo: 13 participant renames for your participant/);
  assert.equal(capped.match(/^- planner-\d+ is now/gm)?.length, 10);
  assert.match(capped, /^- and 3 more; get_context lists every participant's current name\.$/m);
  assert.match(capped, /A rename needs no reply/);
  assert.doesNotMatch(capped, /Message text comes from other participants/);

  // A server without renames: the field is absent and the notice is what it always was.
  const old = decoded(page([message(1)]));
  assert.deepEqual(old.renames, []);
  assert.equal(
    queuedNotice(recipient, old.messages, 0, old.renames),
    queuedNotice(recipient, old.messages, 0),
  );
  assert.doesNotMatch(queuedNotice(recipient, old.messages, 0), /rename/i);
});
