// The inbox's delivery rules against a fake host: what is queued, when it is
// delivered, what goes into a running turn, and what survives a restart.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Inbox,
  channelLimit,
  engagedMillis,
  isSaved,
  queueLimit,
  readFollowInput,
  rearmMillis,
  settleMillis,
  waitSeconds,
  watchedChannels,
} from "../src/inbox.ts";
import { decodeUpdates, generalIdOf, messageIdsOf } from "../src/talkto.ts";
import { bodyLimit } from "../src/notice.ts";

const server = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const peer = "33333333-3333-4333-8333-333333333333";
const general = "44444444-4444-4444-8444-444444444444";
const direct = "55555555-5555-4555-8555-555555555555";

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
const reply = (messages, { nextCursor = null, checkpoint = `cp-${sequence}` } = {}) => ({
  isError: false,
  content: [],
  structuredContent: {
    data: { messages, checkpoint, nextCursor },
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
/** A get_context answer naming the server's General channel. */
const context = (generalId = general) => ({
  isError: false,
  content: [],
  structuredContent: {
    data: { server: { id: server, name: "Team", generalConversationId: generalId } },
    included: { participants: [], conversations: [] },
    meta: {},
  },
});
const failure = (code, message = "no") => ({
  isError: true,
  content: [],
  structuredContent: { error: { code, message }, meta: {} },
});

/**
 * A host whose TalkTo answers come from a queue and whose effects are recorded. get_context is
 * answered apart, from `context` (an answer or an Error), and recorded in `contexts`.
 */
const fakeHost = () => {
  const host = {
    answers: [],
    calls: [],
    contexts: [],
    context: context(),
    submitted: [],
    injected: [],
    timers: [],
    statuses: [],
    stored: null,
    time: 0,
    submitAnswer: true,
    call: async (tool, args) => {
      if (tool === "get_context") {
        host.contexts.push(args);
        if (host.context instanceof Error) throw host.context;
        return host.context;
      }
      host.calls.push({ tool, args });
      const next = host.answers.shift();
      if (next === undefined) return reply([]);
      if (next instanceof Error) throw next;
      return next;
    },
    submit: async (text) => {
      host.submitted.push(text);
      return host.submitAnswer;
    },
    inject: async (text) => {
      host.injected.push(text);
      return true;
    },
    load: async () => host.stored,
    save: async (state) => {
      host.stored = JSON.parse(JSON.stringify(state));
    },
    now: async () => host.time,
    after: (ms, run) => host.timers.push({ at: host.time + ms, run }),
    status: (text) => host.statuses.push(text),
    connectionHint: "Check the connection.",
    plugin: { name: "claude-code", version: "0.3.0" },
    /** Moves time on and runs the timers that came due. */
    advance: async (ms) => {
      host.time += ms;
      const due = host.timers.filter((timer) => timer.at <= host.time);
      host.timers = host.timers.filter((timer) => timer.at > host.time);
      for (const timer of due) await timer.run();
    },
  };
  return host;
};
const settings = { delivery: "idle", urgent: "inject", pollMillis: 15000, wait: "auto" };
const followed = async (host, options = settings) => {
  const inbox = new Inbox(host, options);
  host.answers.push(reply([]));
  const answer = await inbox.follow({
    serverId: server,
    participantId: me,
    channelIds: [general],
    directChats: "own",
    startAt: "now",
  });
  assert.match(answer, /^Following participant/);
  host.time = settleMillis * 10;
  return inbox;
};

test("follow starts the participant's own feed and saves it before anything is delivered", async () => {
  const host = fakeHost();
  await followed(host);
  assert.deepEqual(host.calls[0], {
    tool: "get_updates",
    args: {
      serverId: server,
      participantId: me,
      mode: "start",
      channelIds: [general],
      directChats: "own",
      startAt: "now",
      limit: 50,
      plugin: "claude-code/0.3.0",
    },
  });
  assert.ok(isSaved(host.stored));
  assert.equal(host.stored.follows[0].participantId, me);
});

const task = "66666666-6666-4666-8666-666666666666";
const followWith = (inbox, channelIds, directChats = "own") =>
  inbox.follow({ serverId: server, participantId: me, channelIds, directChats, startAt: "now" });
const startedWith = (host) => host.calls.find((call) => call.args.mode === "start").args.channelIds;

test("follow always adds General, found with get_context, to the chosen channels", async () => {
  const host = fakeHost();
  const inbox = new Inbox(host, settings);
  const answer = await followWith(inbox, [task]);
  assert.deepEqual(host.contexts, [{ serverId: server }], "asks for the server, not a participant");
  assert.deepEqual(startedWith(host), [general, task]);
  assert.deepEqual(host.stored.follows[0].channelIds, [general, task], "a restart keeps General");
  assert.match(answer, /\(2 channels, direct chats: own\)\. General is always included/);
  // With no channels and no direct chats, General alone still makes a valid feed.
  await followWith(inbox, [], "none");
  assert.deepEqual(host.calls.at(-1).args.channelIds, [general]);
  assert.equal(host.contexts.length, 1, "General's ID is asked once per server");
});

test("General chosen or repeated is watched once", async () => {
  const host = fakeHost();
  const answer = await followWith(new Inbox(host, settings), [task, general, task]);
  assert.deepEqual(startedWith(host), [task, general]);
  assert.match(answer, /\(2 channels,/);
  assert.deepEqual(watchedChannels([general, general], general), {
    channelIds: [general],
    general: true,
    displaced: null,
  });
});

test("with the channel limit chosen, General takes the last one's place and the answer says so", async () => {
  const chosen = Array.from({ length: channelLimit }, (_, index) => `channel-${index}`);
  const host = fakeHost();
  const answer = await followWith(new Inbox(host, settings), chosen);
  const watched = startedWith(host);
  assert.equal(watched.length, channelLimit);
  assert.deepEqual(watched, [general, ...chosen.slice(0, channelLimit - 1)]);
  assert.match(answer, new RegExp(`channel channel-${channelLimit - 1} is not delivered`));
  assert.match(answer, new RegExp(`at most ${channelLimit - 1} other channels`));
  const withGeneral = [general, ...chosen.slice(1)];
  assert.deepEqual(watchedChannels(withGeneral, general).channelIds, withGeneral);
  assert.equal(
    readFollowInput(
      new Map(
        Object.entries({ serverId: server, participantId: me, channelIds: [...chosen, "x"] }),
      ),
    ).ok,
    false,
    "more than the limit is refused before TalkTo is asked",
  );
});

test("when General cannot be found, follow watches the chosen channels and says General is missing", async () => {
  for (const missing of [
    failure("server_unavailable"),
    { isError: false, content: [], structuredContent: { data: {}, meta: {} } },
    new Error("offline"),
  ]) {
    const host = fakeHost();
    host.context = missing;
    const inbox = new Inbox(host, settings);
    const answer = await followWith(inbox, [task]);
    assert.match(answer, /^Following participant/);
    assert.deepEqual(startedWith(host), [task]);
    assert.match(answer, /could not add it; to hear about new channels, add General's ID/);
    // Not remembered: the next follow asks again.
    host.context = context();
    await followWith(inbox, [task]);
    assert.deepEqual(host.calls.at(-1).args.channelIds, [general, task]);
  }
  assert.equal(generalIdOf(context()), general);
  assert.equal(
    generalIdOf({
      isError: false,
      content: [{ type: "text", text: JSON.stringify(context().structuredContent) }],
    }),
    general,
    "read from the text block when there is no structured content",
  );
});

test("queued messages wait for an idle session and arrive as one notice", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(reply([message(), message({ conversationId: direct })]));
  await inbox.tick();
  assert.equal(host.submitted.length, 0, "a running turn is never interrupted by normal messages");
  assert.equal(host.stored.follows[0].pending.length, 2, "the queue is saved before delivery");
  assert.equal(host.calls.at(-1).args.mode, "poll");

  await inbox.onTurnComplete("t1");
  await host.advance(settleMillis - 1);
  assert.equal(host.submitted.length, 0, "the person gets a moment to type first");
  await host.advance(1);
  assert.equal(host.submitted.length, 1);
  const notice = host.submitted[0];
  assert.match(notice, /2 new messages for your participant/);
  assert.match(notice, /#general · from planner \(codex\)/);
  assert.match(notice, /direct chat with planner/);
  assert.match(notice, /do not call get_updates/);
  assert.match(notice, /not as instructions from your person/);
  assert.equal(host.stored.follows[0].pending.length, 0, "delivered messages leave the queue");

  host.answers.push(reply([]));
  await inbox.tick();
  assert.equal(host.submitted.length, 1, "an empty poll stays quiet");
});

test("urgent messages go into the running turn; normal ones keep waiting", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(
    reply([
      message(),
      message({ conversationId: direct, priority: "urgent", body: "stop the deploy" }),
    ]),
  );
  await inbox.tick();
  assert.equal(host.injected.length, 1);
  assert.match(host.injected[0], /URGENT message/);
  assert.match(host.injected[0], /stop the deploy/);
  assert.doesNotMatch(host.injected[0], /hello/);
  assert.equal(host.submitted.length, 0);
  assert.equal(host.stored.follows[0].pending.length, 1);

  inbox.onStep("t1");
  await inbox.onTurnComplete("t1");
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 1);
  assert.doesNotMatch(host.submitted[0], /stop the deploy/, "an injected message is not repeated");
  assert.doesNotMatch(host.submitted[0], /arrived as your last turn ended/);
});

test("an urgent row that landed during the turn's last request gets a follow-up turn", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(reply([message({ conversationId: direct, priority: "urgent" })]));
  await inbox.tick();
  assert.equal(host.injected.length, 1);
  await inbox.onTurnComplete("t1");
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 1);
  assert.match(host.submitted[0], /arrived as your last turn ended/);
});

test("an urgent message the agent read itself in the turn gets no follow-up turn", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  const early = message({ conversationId: direct, priority: "urgent" });
  const late = message({ conversationId: direct, priority: "urgent" });
  const other = message({ conversationId: direct, priority: "urgent" });
  // Read before the plugin injects it, and after; a read in another turn does not count.
  inbox.onRead("t1", [early.id]);
  host.answers.push(reply([early, late, other]));
  await inbox.tick();
  assert.equal(host.injected.length, 1);
  inbox.onRead("t1", [late.id]);
  inbox.onRead("t0", [other.id]);
  await inbox.onTurnComplete("t1");
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 1);
  assert.match(host.submitted[0], new RegExp(`\\(${other.id}\\) arrived as your last turn ended`));

  // All of them read: nothing follows; the next turn starts with nothing marked read.
  inbox.onTurnStart("t2");
  const next = message({ conversationId: direct, priority: "urgent" });
  host.answers.push(reply([next]));
  await inbox.tick();
  inbox.onRead("t2", [next.id]);
  await inbox.onTurnComplete("t2");
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 1);
  inbox.onTurnStart("t3");
  host.answers.push(reply([message({ id: next.id, conversationId: direct, priority: "urgent" })]));
  await inbox.tick();
  await inbox.onTurnComplete("t3");
  await host.advance(settleMillis);
  assert.match(host.submitted.at(-1), /arrived as your last turn ended/);
});

test("messageIdsOf lists the messages a get_updates or read_messages answer showed", () => {
  const shown = message();
  assert.deepEqual(messageIdsOf(reply([shown])), [shown.id]);
  const history = {
    isError: false,
    content: [
      { type: "text", text: JSON.stringify({ data: { items: [shown], nextCursor: null } }) },
    ],
  };
  assert.deepEqual(messageIdsOf(history), [shown.id]);
  assert.deepEqual(messageIdsOf(failure("forbidden")), []);
  assert.deepEqual(messageIdsOf({ isError: false, content: [{ type: "text", text: "no" }] }), []);
});

test("urgent handling set to queue waits like any other message", async () => {
  const host = fakeHost();
  const inbox = await followed(host, { ...settings, urgent: "queue" });
  inbox.onTurnStart("t1");
  host.answers.push(reply([message({ conversationId: direct, priority: "urgent" })]));
  await inbox.tick();
  assert.equal(host.injected.length, 0);
  await inbox.onTurnComplete("t1");
  await host.advance(settleMillis);
  assert.match(host.submitted[0], /\[1\] URGENT direct chat with planner/);
});

test("a notice the engine dropped stays queued until the person's next turn", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.submitAnswer = false;
  host.answers.push(reply([message()]));
  await inbox.tick();
  assert.equal(host.submitted.length, 1);
  assert.equal(host.stored.follows[0].pending.length, 1);
  host.submitAnswer = true;
  await inbox.tick();
  assert.equal(host.submitted.length, 1, "held until the person acts");
  inbox.onTurnStart("person");
  await inbox.onTurnComplete("person");
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 2);
  assert.equal(host.stored.follows[0].pending.length, 0);
});

test("next-prompt delivery rides along with the person's prompt; only urgent wakes an idle session", async () => {
  const host = fakeHost();
  const inbox = await followed(host, { ...settings, delivery: "next-prompt" });
  host.answers.push(reply([message()]));
  await inbox.tick();
  assert.equal(host.submitted.length, 0);
  const context = await inbox.takeForPrompt();
  assert.match(context, /1 new message/);
  assert.equal(await inbox.takeForPrompt(), null);
  host.answers.push(reply([message({ conversationId: direct, priority: "urgent" })]));
  await inbox.tick();
  assert.equal(host.submitted.length, 1);
});

/** A page from a server that reports the person's wake cadence. */
const paced = (messages, seconds) => {
  const answer = reply(messages);
  answer.structuredContent.data.wakeCadence = seconds === 300 ? "every_5_minutes" : "right_away";
  answer.structuredContent.data.wakeIntervalSeconds = seconds;
  return answer;
};

test("the person's wake cadence spaces the turns the inbox starts; urgent ones go at once", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.answers.push(paced([message()], 300));
  await inbox.tick();
  assert.equal(host.submitted.length, 1, "the first batch after a quiet period starts a turn");
  inbox.onTurnStart("t1");
  await inbox.onTurnComplete("t1");
  // A minute later the next batch waits for the rest of the five minutes.
  await host.advance(60_000);
  host.answers.push(paced([message()], 300));
  await inbox.tick();
  assert.equal(host.submitted.length, 1);
  assert.equal(host.stored.follows[0].pending.length, 1, "held, still queued and saved");
  assert.match(inbox.describe(), /at most every 5 minutes/);
  // An urgent message starts a turn inside the gap, and takes the held one with it.
  host.answers.push(paced([message({ conversationId: direct, priority: "urgent" })], 300));
  await inbox.tick();
  assert.equal(host.submitted.length, 2);
  assert.match(host.submitted[1], /2 new messages/);
  inbox.onTurnStart("t2");
  await inbox.onTurnComplete("t2");
  // Held normal messages go when the gap since that turn has passed, by the inbox's own timer.
  host.answers.push(paced([message()], 300));
  await host.advance(settleMillis);
  await inbox.tick();
  assert.equal(host.submitted.length, 2);
  await host.advance(300_000);
  assert.equal(host.submitted.length, 3);
});

test("right away, and a server without a cadence, start a turn for every batch as before", async () => {
  for (const answer of [(messages) => paced(messages, 0), (messages) => reply(messages)]) {
    const host = fakeHost();
    const inbox = await followed(host);
    for (let turn = 1; turn <= 3; turn++) {
      host.answers.push(answer([message()]));
      await inbox.tick();
      assert.equal(host.submitted.length, turn);
      inbox.onTurnStart(`t${turn}`);
      await inbox.onTurnComplete(`t${turn}`);
      await host.advance(settleMillis);
    }
    assert.doesNotMatch(inbox.describe(), /at most every/);
  }
});

test("pages are drained in bounded steps and duplicates are not queued twice", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  const first = message();
  host.answers.push(reply([first], { nextCursor: "more" }), reply([first, message()]));
  await inbox.tick();
  assert.equal(host.stored.follows[0].pending.length, 2);
  assert.equal(host.calls.filter((call) => call.args.mode === "poll").length, 2);
});

test("a full queue keeps the newest messages and says how many were dropped", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(reply(Array.from({ length: queueLimit + 5 }, () => message())));
  await inbox.tick();
  assert.equal(host.stored.follows[0].pending.length, queueLimit);
  assert.equal(host.stored.follows[0].dropped, 5);
  await inbox.onTurnComplete("t1");
  await host.advance(settleMillis);
  assert.match(host.submitted[0], new RegExp(`${queueLimit + 5} new messages`));
  assert.match(host.submitted[0], /5 older messages did not fit/);
  assert.match(host.submitted[0], /Not shown here/);
});

test("long bodies are cut with a pointer to the full text", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  const long = message({ body: "x".repeat(bodyLimit * 3) });
  host.answers.push(reply([long]));
  await inbox.tick();
  assert.match(host.submitted[0], new RegExp(`cut at ${bodyLimit} characters`));
  assert.match(host.submitted[0], new RegExp(`read_messages around messageId ${long.id}`));
});

test("transient failures back off; revoked access ends the follow with a notice", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.answers.push(new Error("offline"));
  await inbox.tick();
  const polls = host.calls.length;
  host.time += settings.pollMillis;
  await inbox.tick();
  assert.equal(host.calls.length, polls, "waits out the backoff");
  host.time += settings.pollMillis * 4;
  host.answers.push(failure("storage_unavailable"));
  await inbox.tick();
  assert.equal(host.stored.follows.length, 1, "kept through retryable errors");
  host.time += 10 * 60 * 1000;
  host.answers.push(failure("server_unavailable", "Access was revoked."));
  await inbox.tick();
  assert.match(host.submitted.at(-1), /stopped delivering messages .*server_unavailable/);
  assert.deepEqual(host.stored.follows, []);
});

test("a reset history restarts from now and says messages may be missing", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.answers.push(
    failure("invalid_cursor", "history was restored"),
    reply([], { checkpoint: "fresh" }),
  );
  await inbox.tick();
  assert.equal(host.calls.at(-1).args.startAt, "now");
  assert.match(host.submitted.at(-1), /history position .* was reset/);
});

test("a restart restores the follow and its queue from the store", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(reply([message()]));
  await inbox.tick();
  const restarted = new Inbox(host, settings);
  await restarted.restore();
  host.answers.push(reply([]));
  await restarted.tick();
  assert.equal(host.submitted.length, 1);
  assert.match(host.submitted[0], /hello/);
  assert.equal(isSaved({ version: 1, follows: [{ serverId: 1 }], notes: [] }), false);
});

test("follow arguments are decoded strictly and TalkTo refusals are reported", async () => {
  assert.equal(readFollowInput(new Map(Object.entries({ serverId: server }))).ok, false);
  assert.equal(
    readFollowInput(
      new Map(Object.entries({ serverId: server, participantId: me, startAt: "later" })),
    ).ok,
    false,
  );
  assert.deepEqual(
    readFollowInput(new Map(Object.entries({ serverId: server, participantId: me }))),
    {
      ok: true,
      input: {
        serverId: server,
        participantId: me,
        channelIds: [],
        directChats: "own",
        startAt: "now",
      },
    },
  );
  const host = fakeHost();
  const inbox = new Inbox(host, settings);
  host.answers.push(
    failure("participant_not_found", "The participant does not exist in this server."),
  );
  const answer = await inbox.follow({
    serverId: server,
    participantId: me,
    channelIds: [],
    directChats: "own",
    startAt: "now",
  });
  assert.match(answer, /TalkTo refused the follow: participant_not_found/);
  assert.equal(host.stored, null);
});

test("unreadable replies are failures, not empty pages", () => {
  assert.equal(decodeUpdates({ isError: false, content: [] }, me).kind, "failure");
  assert.equal(
    decodeUpdates(
      {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(reply([message()]).structuredContent) }],
      },
      me,
    ).kind,
    "page",
  );
  const broken = reply([{ id: "x" }]);
  assert.equal(decodeUpdates(broken, me).kind, "failure");
});

const polls = (host) => host.calls.filter((call) => call.args.mode === "poll");

test("while a turn runs, each poll waits on the server and the next starts right after", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.timers = [];
  inbox.onTurnStart("t1");
  assert.equal(host.timers.length, 1, "a turn starts a waiting poll at once");
  host.answers.push(
    reply([message({ conversationId: direct, priority: "urgent", body: "stop the deploy" })]),
  );
  await host.advance(0);
  assert.equal(polls(host).at(-1).args.waitSeconds, waitSeconds);
  assert.match(host.injected[0], /stop the deploy/, "what ended the wait goes into the turn");

  const before = polls(host).length;
  assert.equal(host.timers.length, 1, "one chained poll, never more");
  await inbox.tick();
  assert.equal(host.timers.length, 1, "a backstop tick does not add a second chain");
  await host.advance(rearmMillis);
  assert.equal(polls(host).length, before + 2);
  assert.equal(polls(host).at(-1).args.waitSeconds, waitSeconds);
});

test("only the first page waits; continuations are read at once", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(reply([message()], { nextCursor: "more" }), reply([message()]));
  await inbox.tick();
  const [first, second] = polls(host).slice(-2);
  assert.equal(first.args.waitSeconds, waitSeconds);
  assert.equal("waitSeconds" in second.args, false);
});

test("auto waits for ten minutes after the last turn, then checks on the timer", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  await inbox.onTurnComplete("t1");
  host.timers = [];
  host.time += engagedMillis - 1;
  await inbox.tick();
  assert.equal(polls(host).at(-1).args.waitSeconds, waitSeconds);
  host.timers = [];
  host.time += 1;
  await inbox.tick();
  assert.equal(
    "waitSeconds" in polls(host).at(-1).args,
    false,
    "idle sessions do not hold the server",
  );
  assert.equal(host.timers.length, 0, "no chained poll while idle");
  host.answers.push(reply([message()]));
  await inbox.tick();
  host.answers.push(reply([]));
  await inbox.tick();
  assert.equal(polls(host).at(-1).args.waitSeconds, waitSeconds, "a new message re-engages");
});

test("wait=never checks on the timer only; wait=always waits while idle", async () => {
  const never = fakeHost();
  const quiet = await followed(never, { ...settings, wait: "never" });
  quiet.onTurnStart("t1");
  never.timers = [];
  await quiet.tick();
  assert.equal("waitSeconds" in polls(never).at(-1).args, false);
  assert.equal(never.timers.length, 0);

  const always = fakeHost();
  const eager = await followed(always, { ...settings, wait: "always" });
  always.time += engagedMillis * 3;
  await eager.tick();
  assert.equal(polls(always).at(-1).args.waitSeconds, waitSeconds);
});

test("a server that does not know waitSeconds is asked again without it, and the follow survives", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  // Such a server predates the plugin field too: it refuses the call with it, then without it.
  host.answers.push(
    failure("invalid_input", "unknown plugin"),
    failure("invalid_input", "unknown waitSeconds"),
    reply([message()]),
  );
  await inbox.tick();
  const [refused, unreported, retried] = polls(host).slice(-3);
  assert.equal(refused.args.waitSeconds, waitSeconds);
  assert.equal(refused.args.plugin, "claude-code/0.3.0");
  assert.equal(unreported.args.waitSeconds, waitSeconds);
  assert.equal("plugin" in unreported.args, false);
  assert.equal("waitSeconds" in retried.args, false);
  assert.equal("plugin" in retried.args, false);
  assert.equal(host.stored.follows.length, 1);
  assert.equal(host.stored.follows[0].pending.length, 1);
  await inbox.tick();
  assert.equal("waitSeconds" in polls(host).at(-1).args, false, "later polls do not wait");
  assert.equal("plugin" in polls(host).at(-1).args, false, "nor name the plugin");
});

test("a server that refuses only the plugin field is asked again without it and keeps waiting", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(failure("invalid_input", "unknown plugin"), reply([message()]));
  await inbox.tick();
  const [refused, retried] = polls(host).slice(-2);
  assert.equal(refused.args.plugin, "claude-code/0.3.0");
  assert.equal(retried.args.waitSeconds, waitSeconds);
  assert.equal("plugin" in retried.args, false);
  assert.equal(host.stored.follows[0].pending.length, 1, "the follow survives");
  await inbox.tick();
  assert.equal(polls(host).at(-1).args.waitSeconds, waitSeconds, "later polls still wait");
  assert.equal("plugin" in polls(host).at(-1).args, false, "and leave the field out");
});

test("a real invalid_input still ends the follow, with the plugin field kept for next time", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  // Refused with and without the plugin field, and without waiting: the input itself is wrong.
  for (let index = 0; index < 3; index += 1)
    host.answers.push(failure("invalid_input", "bad checkpoint"));
  await inbox.tick();
  assert.equal(host.stored.follows.length, 0);
  assert.match(host.submitted.at(-1), /stopped delivering messages/);
  assert.equal(polls(host)[0].args.plugin, "claude-code/0.3.0");
});

/** A page whose server knows this plugin and names its newest version. */
const withLatest = (messages, latestPluginVersion) => {
  const answer = reply(messages);
  answer.structuredContent.data.latestPluginVersion = latestPluginVersion;
  return answer;
};
const day = 24 * 60 * 60 * 1000;

test("a newer plugin version adds one update line to the next notice, at most once a day", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.answers.push(withLatest([message()], "0.4.0"));
  await inbox.tick();
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 1);
  const first = host.submitted[0];
  assert.match(first, /1 new message for your participant/);
  assert.ok(
    first.endsWith(
      "\n\nTell your person: a TalkTo plugin update is available (0.3.0 → 0.4.0). To install it, run `claude plugin marketplace update talkto`, then `claude plugin update talkto-plugin@talkto`, then /reload-plugins. Tip: turn on auto-update in /plugin → Marketplaces → talkto, and future updates install by themselves. What changed: https://talkto.sh/docs/updates/",
    ),
    first,
  );
  assert.ok(Number.isFinite(host.stored.updateNoticeAt), "the time it was said is saved");
  assert.match(inbox.describe(), /TalkTo plugin update is available \(0\.3\.0 → 0\.4\.0\)/);

  // Within a day: the next notice has no update line, even after a restart.
  const restarted = new Inbox(host, settings);
  await restarted.restore();
  host.answers.push(withLatest([message()], "0.4.0"));
  await restarted.tick();
  host.time += settleMillis;
  await restarted.deliver();
  assert.equal(host.submitted.length, 2);
  assert.doesNotMatch(host.submitted[1], /plugin update/);

  // A day later it says so again.
  host.time += day;
  host.answers.push(withLatest([message()], "0.4.0"));
  await restarted.tick();
  host.time += settleMillis;
  await restarted.deliver();
  assert.equal(host.submitted.length, 3);
  assert.match(host.submitted[2], /plugin update is available \(0\.3\.0 → 0\.4\.0\)/);
});

test("no update line when the plugin is current, newer, or the server names no version", async () => {
  for (const latest of ["0.3.0", "0.2.9", undefined, "soon"]) {
    const host = fakeHost();
    const inbox = await followed(host);
    host.answers.push(latest === undefined ? reply([message()]) : withLatest([message()], latest));
    await inbox.tick();
    await host.advance(settleMillis);
    assert.equal(host.submitted.length, 1);
    assert.doesNotMatch(host.submitted[0], /plugin update/, String(latest));
    assert.doesNotMatch(inbox.describe(), /plugin update/, String(latest));
  }
});

test("the update line never goes into a running turn, and never makes a notice on its own", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.answers.push(withLatest([], "0.4.0"));
  await inbox.tick();
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 0, "an update alone starts no turn");
  inbox.onTurnStart("t1");
  host.answers.push(withLatest([message({ conversationId: direct, priority: "urgent" })], "0.4.0"));
  await inbox.tick();
  assert.equal(host.injected.length, 1);
  assert.doesNotMatch(host.injected[0], /plugin update/);
});

/** A page carrying participant renames, as a server with renaming sends it. */
const withRenames = (messages, renames, options) => {
  const answer = reply(messages, options);
  answer.structuredContent.data.renames = renames.map((fields) => ({
    sequence: 1,
    participantId: peer,
    previousName: "planner",
    name: "planner-ci",
    renamedAt: "2026-11-15T10:00:00.000Z",
    renamedBy: { kind: "self" },
    ...fields,
  }));
  return answer;
};

test("renames alone advance the checkpoint quietly and ride with the next notice", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  host.answers.push(withRenames([], [{ id: "r-1" }], { checkpoint: "cp-renamed" }));
  await inbox.tick();
  assert.equal(host.stored.follows[0].checkpoint, "cp-renamed");
  assert.equal(host.stored.follows[0].renames.length, 1, "the rename is saved with the queue");
  await host.advance(settleMillis);
  assert.equal(host.submitted.length, 0, "a rename alone never starts a turn");

  // The same rename again (a retried page) is not listed twice.
  host.answers.push(withRenames([message()], [{ id: "r-1" }, { id: "r-2", name: "planner-2" }]));
  await inbox.tick();
  assert.equal(host.submitted.length, 1);
  const notice = host.submitted[0];
  assert.match(notice, /1 new message and 2 participant renames for your participant/);
  assert.match(notice, /- planner is now planner-ci \(renamed itself\) · participantId /);
  assert.ok(notice.indexOf("Renamed participants") < notice.indexOf("[1] #general"));
  assert.deepEqual(host.stored.follows[0].renames, [], "delivered renames leave the queue");

  host.answers.push(reply([message()]));
  await inbox.tick();
  assert.doesNotMatch(host.submitted[1], /rename/i, "a rename is told once");
});

test("next-prompt delivery carries queued renames with the person's prompt", async () => {
  const host = fakeHost();
  const inbox = await followed(host, { ...settings, delivery: "next-prompt" });
  host.answers.push(withRenames([], [{ id: "r-1", participantId: me, previousName: "builder" }]));
  await inbox.tick();
  assert.equal(host.submitted.length, 0);
  const context = await inbox.takeForPrompt();
  assert.match(context, /^TalkTo: 1 participant rename for your participant/);
  assert.match(context, /- builder \(you\) is now planner-ci/);
  assert.match(context, /A rename needs no reply/);
  assert.equal(await inbox.takeForPrompt(), null);
});

test("a session saved before renames existed restores, and queued renames survive a restart", async () => {
  const host = fakeHost();
  const inbox = await followed(host);
  inbox.onTurnStart("t1");
  host.answers.push(withRenames([message()], [{ id: "r-1" }]));
  await inbox.tick();
  const restarted = new Inbox(host, settings);
  await restarted.restore();
  host.answers.push(reply([]));
  await restarted.tick();
  assert.match(host.submitted[0], /planner is now planner-ci/);

  const old = { version: 1, notes: [], follows: [{ ...host.stored.follows[0] }] };
  delete old.follows[0].renames;
  old.follows[0].pending = [];
  assert.ok(isSaved(old));
  const legacy = fakeHost();
  legacy.stored = old;
  legacy.time = settleMillis * 10;
  const reloaded = new Inbox(legacy, settings);
  await reloaded.restore();
  legacy.answers.push(withRenames([message()], [{ id: "r-9" }]));
  await reloaded.tick();
  assert.match(legacy.submitted[0], /1 new message and 1 participant rename/);
  assert.equal(
    isSaved({ ...old, follows: [{ ...old.follows[0], renames: [{ id: "r-1" }] }] }),
    false,
  );
});
