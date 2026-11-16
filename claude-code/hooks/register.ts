/**
 * talkto-plugin for Claude Code: binds the session's TalkTo inbox
 * (`core/inbox.ts`, a copy of `integrations/core/src`) to the engine.
 *
 * - TalkTo is reached only through Claude Code's own MCP connection
 *   (`$.mcp.call`): the plugin never sees or stores a token.
 * - The agent starts delivery itself with the `follow` tool, naming its own
 *   participant; nothing is inferred from the connection.
 * - Turns are tracked on the main loop only; subagents never receive notices.
 * - It delivers in an interactive session and in a T3 Code thread, which
 *   keeps the session and shows a turn the plugin starts
 *   (`session-kind.ts`); every other session gets nothing promised for later.
 * - In a T3 thread only the thread's own Claude delivers (it has T3's
 *   `t3-code` server), and only while it holds the thread's lease in the store.
 */
import type { EngineInterface, PluginOptions, Register } from "claude-code";
import {
  Inbox,
  isSaved,
  readFollowInput,
  type Delivery,
  type Host,
  type Saved,
  type Settings,
  type WaitPolicy,
} from "./core/inbox.ts";
import {
  connectionHintOf,
  deliveryTargetOf,
  followAnswerOf,
  hasT3Server,
  headlessRefusal,
  isForgotten,
  isLeased,
  isPersonPrompt,
  leasedRecord,
  leaseOf,
  leaseRenewMillis,
  leaseStaleMillis,
  mayHold,
  notThreadRefusal,
  sessionKindOf,
  standbyRefusal,
  startingRefusal,
  storeKeyOf,
  t3ServerWaitMillis,
  type SessionKind,
} from "./session-kind.ts";
import {
  followDescription,
  followSchema,
  unfollowDescription,
  unfollowSchema,
} from "./core/tools.ts";

const command = "talkto-inbox";
/** The manifest's key for the bundled TalkTo MCP server. */
const bundledServer = "talkto";

const followSpecOf = (kind: SessionKind) =>
  ({
    name: "follow",
    description: followDescription(deliveryTargetOf(kind)),
    inputSchema: followSchema,
    isDeferred: false,
  }) as const;

const unfollowSpec = {
  name: "unfollow",
  description: unfollowDescription,
  inputSchema: unfollowSchema,
  isDeferred: false,
} as const;

const settingsOf = (options: PluginOptions): Settings & { readonly server: string } => {
  const delivery: Delivery = options["delivery"] === "next-prompt" ? "next-prompt" : "idle";
  const seconds = Number(options["pollSeconds"] ?? 15);
  const waiting = options["wait"];
  const wait: WaitPolicy = waiting === "always" || waiting === "never" ? waiting : "auto";
  return {
    delivery,
    urgent: options["urgent"] === "queue" ? "queue" : "inject",
    pollMillis: Math.max(5, Math.min(300, Number.isFinite(seconds) ? seconds : 15)) * 1000,
    wait,
    server: String(options["mcpServer"] ?? "").trim(),
  };
};

/** The TalkTo MCP server's name in this session: configured, bundled, or found by its tools. */
const serverOf = async ($: EngineInterface, configured: string): Promise<string> => {
  if (configured !== "") return configured;
  const bundled = await $.mcp.connect(bundledServer);
  if (bundled.isConnected) return bundled.server;
  const names = new Set((await $.tool.list()).map((tool) => tool.name));
  for (const name of names) {
    const match = /^mcp__(.+)__get_updates$/.exec(name);
    if (match?.[1] !== undefined && names.has(`mcp__${match[1]}__register_participant`))
      return match[1];
  }
  throw new Error(
    "no TalkTo MCP server is connected in this session; run /mcp and authenticate TalkTo",
  );
};

/** The session's kind, from what Claude Code says and the variables T3 Code sets. */
const kindOf = async ($: EngineInterface, isInteractive: boolean): Promise<SessionKind> =>
  isInteractive
    ? { kind: "terminal" }
    : sessionKindOf(false, {
        entrypoint: await $.env.get("CLAUDE_CODE_ENTRYPOINT"),
        thread: await $.env.get("T3CODE_THREAD_ID"),
        claudecode: await $.env.get("CLAUDECODE"),
        childSession: await $.env.get("CLAUDE_CODE_CHILD_SESSION"),
      });

/** What the plugin can do in this session right now. */
type Phase =
  /** session.start has not finished, or a T3 thread candidate is still looking for T3's server. */
  | "starting"
  /** The inbox is on: this session delivers. */
  | "ready"
  /** A T3 thread process while another live process for the thread holds its lease. */
  | "standby"
  /** T3's environment without T3's own MCP server: a helper run or a script, never the thread. */
  | "not-thread"
  /** The session ended: the process is going away and the lease is free. */
  | "ended"
  | "headless";

const refusalOf = (phase: Phase): string => {
  if (phase === "starting") return startingRefusal;
  if (phase === "standby") return standbyRefusal;
  if (phase === "not-thread") return notThreadRefusal;
  return headlessRefusal;
};

/** One T3 thread's lease, held by this plugin instance (`holder`) under the thread's store key. */
interface ThreadLease {
  readonly key: string;
  readonly holder: string;
}

const emptyState: Saved = { version: 1, follows: [], notes: [] };

/** Takes the thread's lease if it is free, then reads it back: of two at once, the last write wins. */
const claimLease = async ($: EngineInterface, lease: ThreadLease): Promise<boolean> => {
  const stored = await $.store.get(lease.key);
  const now = await $.clock.now();
  if (!mayHold(leaseOf(isLeased(stored) ? stored : null), lease.holder, now)) return false;
  const state = isSaved(stored) ? stored : emptyState;
  await $.store.set(lease.key, leasedRecord(state, { holder: lease.holder, aliveAt: now }));
  await $.clock.sleep(500);
  const confirmed = await $.store.get(lease.key);
  return isLeased(confirmed) && confirmed.lease.holder === lease.holder;
};

/**
 * Writes the thread's state (or keeps the stored one) with a renewed lease; false, writing
 * nothing, when another live process holds the lease. A thread that follows no one keeps its
 * record for the lease; `forgetOldThreads` removes it once nobody renews it.
 */
const writeLeased = async (
  $: EngineInterface,
  lease: ThreadLease,
  state: Saved | null,
): Promise<boolean> => {
  const stored = await $.store.get(lease.key);
  const now = await $.clock.now();
  if (!mayHold(leaseOf(isLeased(stored) ? stored : null), lease.holder, now)) return false;
  const next = state ?? (isSaved(stored) ? stored : emptyState);
  await $.store.set(lease.key, leasedRecord(next, { holder: lease.holder, aliveAt: now }));
  return true;
};

/**
 * Frees the thread's lease as this process ends, so the next process for the thread takes over
 * at once instead of waiting for the lease to go stale. The follow stays.
 */
const releaseLease = async ($: EngineInterface, lease: ThreadLease): Promise<void> => {
  const stored = await $.store.get(lease.key);
  if (!isLeased(stored) || stored.lease.holder !== lease.holder || !isSaved(stored)) return;
  // Stale from now on, but still recent enough that the record is kept.
  const aliveAt = (await $.clock.now()) - leaseStaleMillis - 1;
  await $.store.set(lease.key, leasedRecord(stored, { holder: lease.holder, aliveAt }));
};

/** Removes thread records nobody has renewed for a month: their threads are gone. */
const forgetOldThreads = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now();
  for (const key of await $.store.keys()) {
    if (!key.startsWith("t3:")) continue;
    const stored = await $.store.get(key);
    if (isForgotten(leaseOf(isLeased(stored) ? stored : null), now)) await $.store.delete(key);
  }
};

/** Waits for T3's own MCP server to appear; false when it never does. */
const waitForT3Server = async ($: EngineInterface): Promise<boolean> => {
  const deadline = (await $.clock.now()) + t3ServerWaitMillis;
  while (true) {
    if (hasT3Server((await $.tool.list()).map((tool) => tool.name))) return true;
    if ((await $.clock.now()) > deadline) return false;
    await $.clock.sleep(1000);
  }
};

const hostOf = (
  $: EngineInterface,
  kind: SessionKind,
  sessionId: string,
  configured: string,
  isLive: () => boolean,
  onLost: () => void,
): Host & { readonly lease: ThreadLease | null } => {
  const key = storeKeyOf(kind, sessionId);
  const lease: ThreadLease | null =
    kind.kind === "t3"
      ? { key, holder: `${sessionId}:${Math.random().toString(36).slice(2)}` }
      : null;
  let server: string | null = null;
  return {
    call: async (tool, args) => {
      server ??= await serverOf($, configured);
      try {
        return await $.mcp.call(server, tool, args);
      } catch (cause) {
        server = null;
        throw cause;
      }
    },
    // A process that lost the thread's lease delivers nothing: the holder does.
    submit: async (text) => isLive() && !("drop" in (await $.prompt.submit({ text }))),
    inject: async (text) =>
      isLive() &&
      !(
        "deny" in
        (await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }))
      ),
    load: async () => {
      const stored = await $.store.get(key);
      return isSaved(stored) ? stored : null;
    },
    save: async (state) => {
      if (lease !== null) {
        if (!(await writeLeased($, lease, state))) onLost();
        return;
      }
      await (state.follows.length === 0 && state.notes.length === 0
        ? $.store.delete(key)
        : $.store.set(key, state));
    },
    now: () => $.clock.now(),
    after: (ms, run) => {
      // A process that stood down runs none of the inbox's timers.
      $.clock.after(ms, () => (isLive() ? run() : Promise.resolve()).catch(() => undefined));
    },
    status: (text) => $.ui.status(text),
    connectionHint: connectionHintOf(kind),
    lease,
  };
};

/** What the hooks share for one session: what the plugin can do now, and the main turn. */
interface Live {
  inbox: Inbox | null;
  phase: Phase;
  kind: SessionKind;
  /**
   * The main turn in progress, tracked even before the inbox is on: a turn can start while
   * session.start is still running (T3 starts a thread's Claude with the person's message).
   */
  running: string | null;
  /** The thread's lease in a T3 thread candidate, else null. */
  lease: ThreadLease | null;
}

/** Restores the stored follow, switches the inbox on and polls at once. */
const activate = async ($: EngineInterface, live: Live, created: Inbox): Promise<void> => {
  await created.restore();
  live.inbox = created;
  live.phase = "ready";
  if (live.running !== null) created.onTurnStart(live.running);
  $.clock.after(0, () => created.tick().catch(() => undefined));
};

/** Stops delivering: another process holds the thread's lease. */
const standDown = (live: Live): void => {
  live.inbox = null;
  live.phase = "standby";
};

/**
 * A T3 thread candidate: wait for T3's own server, then deliver only while holding the
 * thread's lease. A process that loses the lease stops; one that waits takes over once the
 * holder stops renewing it.
 */
const runThread = async (
  $: EngineInterface,
  live: Live,
  created: Inbox,
  lease: ThreadLease,
): Promise<void> => {
  if (!(await waitForT3Server($))) {
    live.phase = "not-thread";
    return;
  }
  await forgetOldThreads($);
  if (await claimLease($, lease)) await activate($, live, created);
  else live.phase = "standby";
  $.clock.every(leaseRenewMillis, () => renewThread($, live, created, lease));
};

const renewThread = async (
  $: EngineInterface,
  live: Live,
  created: Inbox,
  lease: ThreadLease,
): Promise<void> => {
  if (live.phase === "ready") {
    if (!(await writeLeased($, lease, null))) standDown(live);
  } else if (live.phase === "standby" && (await claimLease($, lease)))
    await activate($, live, created);
};

/** Sets the session up: the tools at once, then the inbox (for a T3 thread, once it is the thread). */
const startSession = async (
  $: EngineInterface,
  live: Live,
  settings: Settings & { readonly server: string },
  isInteractive: boolean,
): Promise<void> => {
  live.kind = await kindOf($, isInteractive);
  // A -p run or another SDK host may end with its turn: nothing would be there to deliver to.
  if (live.kind.kind === "headless") {
    live.phase = "headless";
    return;
  }
  const host = hostOf(
    $,
    live.kind,
    await $.session.id(),
    settings.server,
    () => live.phase === "ready",
    () => standDown(live),
  );
  const created = new Inbox(host, settings);
  await $.tool.register(followSpecOf(live.kind));
  await $.tool.register(unfollowSpec);
  await $.command.register({
    name: command,
    description: "Show which TalkTo participant this session follows and what is queued.",
  });
  $.clock.every(settings.pollMillis, async () => {
    if (live.phase === "ready") await created.tick().catch(() => undefined);
  });
  const lease = host.lease;
  live.lease = lease;
  // T3 adds its own server only after Claude has started: look for it off session.start.
  if (lease !== null) $.clock.after(0, () => runThread($, live, created, lease));
  else await activate($, live, created);
};

export const register: Register = (on, options) => {
  const settings = settingsOf(options);
  const live: Live = {
    inbox: null,
    phase: "starting",
    kind: { kind: "headless" },
    running: null,
    lease: null,
  };

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await startSession($, live, settings, e.isInteractive);
    return started;
  });

  // A thread's Claude that ends (T3 released or closed it) frees the lease for the next one.
  on("session.end", async ($, e, next) => {
    const lease = live.lease;
    if (lease !== null && e.reason !== "clear" && live.phase === "ready") {
      live.inbox = null;
      live.phase = "ended";
      await releaseLease($, lease).catch(() => undefined);
    }
    return next(e);
  });

  on("tool.call", { tool: "mcp__talkto-plugin__follow" }, async (_$, e) => {
    if (live.inbox === null || live.phase !== "ready") return { deny: refusalOf(live.phase) };
    const read = readFollowInput(new Map(Object.entries(e)));
    return {
      result: read.ok
        ? followAnswerOf(live.kind, settings, await live.inbox.follow(read.input))
        : read.problem,
    };
  }).catch(() => ({ deny: "talkto-plugin could not start the follow; try again." }));

  on("tool.call", { tool: "mcp__talkto-plugin__unfollow" }, async (_$, e) => {
    if (live.inbox === null || live.phase !== "ready") return { deny: refusalOf(live.phase) };
    const serverId = "serverId" in e ? String(e.serverId) : "";
    return { result: await live.inbox.unfollow(serverId) };
  }).catch(() => ({ deny: "talkto-plugin could not stop the follow; try again." }));

  on("command.run", { command }, async () => ({
    text:
      live.inbox !== null && live.phase === "ready" ? live.inbox.describe() : refusalOf(live.phase),
  }));

  on("turn.start", async (_$, e, next) => {
    if (e.agentId === undefined) {
      live.running = e.turnId;
      live.inbox?.onTurnStart(e.turnId);
    }
    return next(e);
  });

  on("turn.step", async function* (_$, e, next) {
    if (e.agentId === undefined) live.inbox?.onStep(e.turnId);
    return yield* next(e);
  });

  on("turn.complete", async (_$, e, next) => {
    const completed = await next(e);
    if (e.agentId === undefined) {
      if (live.running === e.turnId) live.running = null;
      await live.inbox?.onTurnComplete(e.turnId);
    }
    return completed;
  });

  // With next-prompt delivery, what is queued rides along with the person's own prompt.
  on("prompt.submit", async (_$, e, next) => {
    const inbox = live.inbox;
    if (inbox === null || !isPersonPrompt(live.kind, e.origin.kind) || e.command !== undefined)
      return next(e);
    const queued = await inbox.takeForPrompt();
    return next(queued === null ? e : { ...e, context: [...(e.context ?? []), queued] });
  }).catch((_$, e, next) => next(e));
};
