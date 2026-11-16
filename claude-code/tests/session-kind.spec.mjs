// Which kind of session the plugin is in, who owns a T3 thread, and what it
// tells the agent in each. What can regress: a T3 Code thread read as
// headless (no follow tool, no wake), a run started inside a thread taken for
// the thread (it would deliver the thread's messages), two live processes
// both holding a thread, a thread ID form rejected, and a sentence that
// promises a wake or a sign-in the session cannot get.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryRules } from "../hooks/core/inbox.ts";
import {
  connectionHintOf,
  deliveryTargetOf,
  followAnswerOf,
  hasT3Server,
  headlessRefusal,
  isForgotten,
  isLeased,
  isPersonPrompt,
  isT3ThreadId,
  leaseStaleMillis,
  mayHold,
  notThreadRefusal,
  recordForgetMillis,
  sessionKindOf,
  standbyRefusal,
  startingRefusal,
  storeKeyOf,
  t3ReleaseNoteOf,
  t3ThreadOf,
} from "../hooks/session-kind.ts";

/** Every ID form T3 gives a thread, and look-alikes it never gives. */
const threads = [
  "0f8fad5b-d9cb-469f-a165-70867728950e",
  "mcp:0f8fad5b-d9cb-469f-a165-70867728950e",
  `mcp:launch:${"a".repeat(64)}`,
  "mcp:0f8fad5b-d9cb-469f-a165-70867728950e:fork",
  "import:claudeAgent:ses_1",
  "thread:mcp:ns:req%20one:2",
  "thread:project:p1:0f8fad5b-d9cb-469f-a165-70867728950e",
  "thread:delegated-task:cmd",
  "thread:subagent:0123456789abcdef",
  "thread:provider:claudeAgent:native-thread:it's(1)!*~",
];
const notThreads = ["", " ", ":mcp", "-x", "a b", "a/b", "a\nb", "x".repeat(4097), undefined];

const t3 = (extra = {}) => ({
  entrypoint: "t3-code",
  thread: threads[0],
  claudecode: undefined,
  childSession: undefined,
  ...extra,
});

test("every thread ID form T3 gives is a thread; look-alikes are not", () => {
  for (const id of threads) assert.equal(isT3ThreadId(id), true, id);
  for (const id of notThreads) assert.equal(isT3ThreadId(id), false, String(id));
});

test("a thread is the entrypoint t3-code beside a thread ID, in every ID form", () => {
  for (const id of threads) assert.equal(t3ThreadOf(t3({ thread: id })), id);
  for (const id of notThreads) assert.equal(t3ThreadOf(t3({ thread: id })), null);
  for (const entrypoint of ["cli", "sdk-ts", "sdk-cli", "claude-vscode", "T3-CODE", "", undefined])
    assert.equal(t3ThreadOf(t3({ entrypoint })), null, String(entrypoint));
});

test("a run started inside a thread inherits its variables but is not the thread", () => {
  assert.equal(t3ThreadOf(t3({ claudecode: "1" })), null);
  assert.equal(t3ThreadOf(t3({ childSession: "1" })), null);
  assert.equal(t3ThreadOf(t3({ claudecode: "1", childSession: "1" })), null);
  assert.equal(t3ThreadOf(t3({ claudecode: "" })), threads[0]);
});

test("the session kinds: the terminal first, then a T3 thread, else headless", () => {
  // An interactive session is the terminal whatever T3 variables it inherited.
  assert.deepEqual(sessionKindOf(true, t3()), { kind: "terminal" });
  assert.deepEqual(sessionKindOf(false, t3()), { kind: "t3", thread: threads[0] });
  assert.deepEqual(sessionKindOf(false, t3({ thread: undefined })), { kind: "headless" });
  assert.deepEqual(sessionKindOf(false, t3({ claudecode: "1" })), { kind: "headless" });
});

test("a thread's follows are stored under the thread, a session's under the session", () => {
  assert.equal(storeKeyOf({ kind: "t3", thread: threads[2] }, "s1"), `t3:${threads[2]}`);
  assert.equal(storeKeyOf({ kind: "terminal" }, "s1"), "session:s1");
});

test("a thread candidate is the thread only with T3's own t3-code server", () => {
  assert.equal(hasT3Server(["mcp__t3-code__t3_thread_send", "Bash"]), true);
  assert.equal(hasT3Server([]), false);
  assert.equal(hasT3Server(["Bash", "mcp__talkto__get_updates", "mcp__t3-codex__x"]), false);
});

test("one live holder per thread: a lease is free when absent, its own, or stale", () => {
  const now = 1_000_000;
  assert.equal(mayHold(null, "a", now), true);
  assert.equal(mayHold({ holder: "a", aliveAt: now }, "a", now), true);
  assert.equal(mayHold({ holder: "b", aliveAt: now - 1_000 }, "a", now), false);
  assert.equal(mayHold({ holder: "b", aliveAt: now - leaseStaleMillis }, "a", now), false);
  assert.equal(mayHold({ holder: "b", aliveAt: now - leaseStaleMillis - 1 }, "a", now), true);

  assert.equal(isLeased({ version: 1, lease: { holder: "a", aliveAt: 5 } }), true);
  for (const value of [null, 1, {}, { lease: null }, { lease: { holder: 1, aliveAt: 5 } }])
    assert.equal(isLeased(value), false, JSON.stringify(value));
  assert.equal(isLeased({ lease: { holder: "a", aliveAt: Number.NaN } }), false);

  assert.equal(isForgotten(null, now), false);
  assert.equal(isForgotten({ holder: "a", aliveAt: now - recordForgetMillis }, now), false);
  assert.equal(isForgotten({ holder: "a", aliveAt: now - recordForgetMillis - 1 }, now), true);
});

const idle = { delivery: "idle", urgent: "inject", pollMillis: 15_000, wait: "auto" };
const nextPrompt = { ...idle, delivery: "next-prompt" };

test("the follow answer's promise follows the settings", () => {
  assert.equal(
    deliveryRules(idle),
    "New messages wait in a queue and arrive as one notice after you finish a turn; urgent direct messages arrive inside your running turn.",
  );
  assert.equal(
    deliveryRules({ ...idle, urgent: "queue" }),
    "New messages wait in a queue and arrive as one notice after you finish a turn; urgent direct messages wait with the others.",
  );
  assert.equal(
    deliveryRules(nextPrompt),
    "New messages wait in a queue and arrive with the person's next prompt; urgent direct messages arrive inside your running turn, or start a turn when you are idle.",
  );
  assert.equal(
    deliveryRules({ ...nextPrompt, urgent: "queue" }),
    "New messages wait in a queue and arrive with the person's next prompt; urgent direct messages arrive as a notice of their own once your turn ends.",
  );
});

test("the sentence each kind of session gets", () => {
  const terminal = { kind: "terminal" };
  const thread = { kind: "t3", thread: threads[0] };
  const followed = "Following participant p on server s (0 channels, direct chats: own).";

  assert.equal(deliveryTargetOf(terminal), "this Claude Code session");
  assert.equal(deliveryTargetOf(thread), "this T3 Code thread");

  // The terminal's answer is the inbox's own; a thread's adds the release, and the person.
  assert.equal(followAnswerOf(terminal, idle, followed), followed);
  assert.equal(followAnswerOf(thread, idle, followed), `${followed} ${t3ReleaseNoteOf(idle)}`);
  assert.equal(
    t3ReleaseNoteOf(idle),
    "In T3 Code: while T3 keeps this thread's Claude running, TalkTo messages reach you here as described. T3 releases a thread's Claude after 30 minutes without a turn, and then nothing can wake this thread: messages wait in TalkTo and arrive after the person next writes in this thread. Tell your person this, so a message that waits does not look delivered.",
  );
  assert.match(t3ReleaseNoteOf(nextPrompt), /arrive with a later message from the person/);
  // A refused follow promises nothing.
  const refused = "TalkTo refused the follow: participant_not_found: no such participant";
  assert.equal(followAnswerOf(thread, idle, refused), refused);

  // A session that cannot deliver is never told that messages arrive by themselves.
  assert.match(headlessRefusal, /may end with its turn, so nothing will bring messages to it/);
  for (const refusal of [headlessRefusal, notThreadRefusal, startingRefusal, standbyRefusal])
    assert.doesNotMatch(refusal, /arrive by themselves|will arrive/);
  assert.equal(startingRefusal, "talkto-plugin is still starting; try again in a moment.");
  assert.match(notThreadRefusal, /get_updates/);

  assert.equal(connectionHintOf(terminal), "Check /mcp and authenticate TalkTo.");
  // T3's sign-in route has not been tried: the hint says so instead of promising it.
  assert.match(connectionHintOf(thread), /has not been checked/);
});

test("the person's prompt: the composer, and in a T3 thread the SDK host's turn", () => {
  const terminal = { kind: "terminal" };
  const thread = { kind: "t3", thread: threads[0] };
  assert.equal(isPersonPrompt(terminal, "composer"), true);
  assert.equal(isPersonPrompt(terminal, "sdk"), false);
  assert.equal(isPersonPrompt(thread, "sdk"), true);
  assert.equal(isPersonPrompt(thread, "plugin"), false);
  assert.equal(isPersonPrompt(thread, "system"), false);
});
