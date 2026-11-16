/**
 * Which kind of Claude Code session the plugin runs in, who owns a T3
 * thread's follow, and what the plugin tells the agent in each case. Pure:
 * register.ts reads the environment, the tool list and the store and passes
 * them in.
 *
 * - `terminal`: a person at Claude Code's own prompt (`isInteractive`).
 * - `t3`: a T3 Code thread (pingdotgg/t3code, 0.1.7 or later). T3 runs the
 *   thread's Claude through the Agent SDK, so the session is not interactive,
 *   but T3 keeps the process and shows a turn the plugin starts. T3 sets
 *   `CLAUDE_CODE_ENTRYPOINT=t3-code` and `T3CODE_THREAD_ID` for a thread's
 *   Claude, and removes `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION`. T3
 *   before 0.1.7 sets no entrypoint, so its threads are `headless`.
 * - `headless`: every other session that is not interactive: `claude -p`,
 *   another Agent SDK app, a Claude T3 runs for no thread. Such a run may end
 *   with its turn, so the plugin promises it nothing for later.
 *
 * The environment only makes a session a thread candidate: anything started
 * with T3's environment inherits it. A `claude -p` in the thread's shell gets
 * `CLAUDECODE` from Claude Code and is headless at once. Other runs can look
 * like the thread: T3's own title generation when T3 itself was started with
 * an inherited `T3CODE_THREAD_ID`, or an Agent SDK script that removes
 * `CLAUDECODE`. So a candidate becomes the thread only once it has T3's own
 * `t3-code` MCP server, which T3 gives a thread's Claude through the SDK
 * (never through the environment) and which its helper runs never get
 * (`hasT3Server`). Even then it delivers only while it holds the thread's
 * lease (`Lease`), so two processes for one thread never both deliver.
 */
import type { Saved, Settings } from "./core/inbox.ts";
import { isObject, isText } from "./core/talkto.ts";

/** The entrypoint T3 Code gives the Claude it runs for a thread. */
export const t3Entrypoint = "t3-code";

/**
 * A thread ID as T3 gives it. T3 IDs are not only UUIDs: `mcp:<uuid>`,
 * `mcp:launch:<hex>`, forks, imported, delegated, subagent and provider
 * threads all exist. The same rule as Plannotator's `isT3ThreadId`.
 */
const t3ThreadPattern = /^[A-Za-z0-9][A-Za-z0-9._~%:!*'()-]{0,4095}$/;

export const isT3ThreadId = (value: string | undefined): value is string =>
  value !== undefined && t3ThreadPattern.test(value);

/** The variables the session kind depends on, as `$.env.get` answers them. */
export interface SessionEnv {
  /** `CLAUDE_CODE_ENTRYPOINT` */
  readonly entrypoint: string | undefined;
  /** `T3CODE_THREAD_ID` */
  readonly thread: string | undefined;
  /** `CLAUDECODE` */
  readonly claudecode: string | undefined;
  /** `CLAUDE_CODE_CHILD_SESSION` */
  readonly childSession: string | undefined;
}

const isSet = (value: string | undefined) => value !== undefined && value !== "";

/** The T3 Code thread this session's environment names, or null. */
export const t3ThreadOf = (env: SessionEnv): string | null => {
  if (env.entrypoint !== t3Entrypoint || !isT3ThreadId(env.thread)) return null;
  // A run started from inside a thread (or from inside any Claude Code session) is not the thread.
  if (isSet(env.claudecode) || isSet(env.childSession)) return null;
  return env.thread;
};

export type SessionKind =
  | { readonly kind: "terminal" }
  | { readonly kind: "t3"; readonly thread: string }
  | { readonly kind: "headless" };

export const sessionKindOf = (isInteractive: boolean, env: SessionEnv): SessionKind => {
  if (isInteractive) return { kind: "terminal" };
  const thread = t3ThreadOf(env);
  return thread === null ? { kind: "headless" } : { kind: "t3", thread };
};

/** The prefix of the tools of T3's own MCP server, which T3 adds to a thread's Claude only. */
export const t3ServerPrefix = "mcp__t3-code__";

export const hasT3Server = (toolNames: ReadonlyArray<string>): boolean =>
  toolNames.some((name) => name.startsWith(t3ServerPrefix));

/**
 * How long a thread candidate looks for T3's server before it stands down.
 * T3 adds the server once Claude has started, usually within seconds.
 */
export const t3ServerWaitMillis = 3 * 60 * 1000;

/**
 * Where the session's follows are stored. A T3 thread keeps its follows
 * under the thread, so the Claude that T3 starts again for the same thread
 * (after it released an idle one) picks up the same follow and checkpoint.
 */
export const storeKeyOf = (kind: SessionKind, sessionId: string): string =>
  kind.kind === "t3" ? `t3:${kind.thread}` : `session:${sessionId}`;

/**
 * Which plugin instance delivers a thread's messages: the one named in the
 * stored record's `lease`, while it renews the lease. Each instance has its
 * own `holder`, so two processes for one thread are told apart even when T3
 * gives them the same Claude session ID (it starts and resumes a thread's
 * Claude under one ID).
 */
export interface Lease {
  readonly holder: string;
  readonly aliveAt: number;
}

/** How often the holder renews its lease. */
export const leaseRenewMillis = 20 * 1000;
/** A lease not renewed for this long is free: its process has ended. */
export const leaseStaleMillis = 60 * 1000;
/** A thread record whose lease nobody renewed for this long is removed: the thread is gone. */
export const recordForgetMillis = 30 * 24 * 60 * 60 * 1000;

/** Whether a stored value is a record with a lease. */
export const isLeased = (value: unknown): value is { readonly lease: Lease } => {
  if (!isObject(value)) return false;
  const lease = new Map(Object.entries(value)).get("lease");
  if (!isObject(lease)) return false;
  const fields = new Map(Object.entries(lease));
  return isText(fields.get("holder")) && Number.isFinite(fields.get("aliveAt"));
};

/** The lease in a stored record, or null when it has none. */
export const leaseOf = (record: { readonly lease: Lease } | null): Lease | null =>
  record === null ? null : record.lease;

/** Whether `holder` may take or keep the thread: the lease is its own, absent, or stale. */
export const mayHold = (lease: Lease | null, holder: string, now: number): boolean =>
  lease === null || lease.holder === holder || now - lease.aliveAt > leaseStaleMillis;

/** The record a thread's holder stores: the inbox's state and its lease. */
export const leasedRecord = (state: Saved, lease: Lease): Saved & { readonly lease: Lease } => ({
  ...state,
  lease,
});

/** Whether a thread record with this lease was left so long ago that it should be removed. */
export const isForgotten = (lease: Lease | null, now: number): boolean =>
  lease !== null && now - lease.aliveAt > recordForgetMillis;

/** How the follow tool names where messages are delivered. */
export const deliveryTargetOf = (kind: SessionKind): string =>
  kind.kind === "t3" ? "this T3 Code thread" : "this Claude Code session";

/**
 * T3 releases a thread's Claude after 30 minutes without a turn. The plugin
 * lives in that process, so after the release nothing can start a turn in
 * the thread: messages wait in TalkTo until the thread runs again.
 */
export const t3ReleaseNoteOf = (settings: Settings): string =>
  `In T3 Code: while T3 keeps this thread's Claude running, TalkTo messages reach you here as described. T3 releases a thread's Claude after 30 minutes without a turn, and then nothing can wake this thread: messages wait in TalkTo and arrive ${settings.delivery === "idle" ? "after the person next writes in this thread" : "with a later message from the person in this thread"}. Tell your person this, so a message that waits does not look delivered.`;

/** What the follow tool answers in this kind of session, after the inbox's own answer. */
export const followAnswerOf = (kind: SessionKind, settings: Settings, answer: string): string =>
  kind.kind === "t3" && answer.startsWith("Following ")
    ? `${answer} ${t3ReleaseNoteOf(settings)}`
    : answer;

/** The answer while the plugin starts: tools are registered before the inbox is on. */
export const startingRefusal = "talkto-plugin is still starting; try again in a moment.";

/** The answer in a T3 thread candidate that never got T3's own MCP server. */
export const notThreadRefusal =
  "talkto-plugin does not deliver here: this session has T3 Code's environment but not T3's own t3-code MCP server, so it is not a T3 thread's own Claude (it may be a T3 helper run or a script started inside a thread). Nothing will bring messages to it. Check for messages yourself with get_updates.";

/** The answer in a thread process while another live process for the same thread holds its lease. */
export const standbyRefusal =
  "Another Claude process for this T3 thread delivers its TalkTo messages right now, so this one does not. Try again in a minute; if that process has ended by then, this one takes over.";

/**
 * Why the plugin does not deliver in a headless session. The follow tool is
 * not registered there; this is the answer if it is called anyway.
 */
export const headlessRefusal =
  "talkto-plugin delivers only where something keeps the session open: an interactive Claude Code session or a T3 Code thread. This session (a claude -p run or another Agent SDK app) may end with its turn, so nothing will bring messages to it. Check for messages yourself with get_updates.";

/** What the agent should do when TalkTo cannot be reached. */
export const connectionHintOf = (kind: SessionKind): string =>
  kind.kind === "t3"
    ? "Check that TalkTo is connected for this Claude. T3 Code has no /mcp screen: the person connects and signs in to TalkTo with /mcp in Claude Code in a terminal. Whether T3's Claude then uses that sign-in has not been checked, and it does not when T3 runs Claude with its own Claude home folder."
    : "Check /mcp and authenticate TalkTo.";

/**
 * Whether a prompt is the person's own. In a T3 thread the person's message
 * reaches Claude Code as the SDK host's turn (`sdk`), not from the composer.
 * T3's own automatic turns (usage-limit recovery, scheduled tasks) also
 * arrive as `sdk`; queued messages riding on one are still shown in the thread.
 */
export const isPersonPrompt = (kind: SessionKind, origin: string): boolean =>
  origin === "composer" || (kind.kind === "t3" && origin === "sdk");
