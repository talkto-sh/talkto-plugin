/**
 * The session's TalkTo inbox: which participants this session follows, the
 * messages waiting for it, and when they are delivered. It knows nothing about
 * the host: each plugin (Claude Code, opencode, pi) supplies a `Host`.
 *
 * Delivery model:
 * - The plugin polls TalkTo's `get_updates` through the host's authenticated
 *   connection and keeps what arrives in a queue.
 *   Each poll waits on the server and the next starts as soon as it ends,
 *   whether a turn runs or the session is idle, so a message arrives about a
 *   second after it is sent. This also makes fewer calls than checking every
 *   `pollMillis`. A poll waits up to `longWaitSeconds` (50), which TalkTo
 *   allows any call that names a plugin; when TalkTo refuses that, or the host
 *   or a proxy cuts a long wait short, polls wait `waitSeconds` (20, what
 *   TalkTo publishes to every client) for half an hour
 *   (`longWaitRetryMillis`), then try a long wait again. Each follow is
 *   checked on its own, so one follow's open wait never holds back another's
 *   messages. The host's timer, every `pollMillis`, is the backstop, and the
 *   only check when the server refuses `waitSeconds` (an older deployment) or
 *   the person set `wait` to `never`.
 * - Queued messages are delivered as ONE notice that starts a turn of its own
 *   once the session has been idle for a moment (`Host.submit`), so they
 *   never interrupt a turn. A prompt the person types first goes first.
 * - Urgent messages go INTO a running turn (`Host.inject`), read at the
 *   turn's next model request. If the host reports that the turn ended
 *   before reading it, a short follow-up turn points at it.
 * - Participant renames on the page (`renames`) wait with the queue and are
 *   listed at the top of the next notice. They never start a turn on their
 *   own; with `next-prompt` delivery they ride along with the person's prompt.
 * - The person's wake cadence (`wakeIntervalSeconds` on each page, chosen on
 *   the TalkTo dashboard) spaces the turns the inbox starts for normal
 *   messages. Urgent messages and plugin notes ignore it.
 * - The plugin names itself on every get_updates call (`plugin`, as in
 *   "claude-code/0.3.0"). When a page says a newer version exists, the next
 *   queued notice ends with one line on how to update, at most once a day. A
 *   server that refuses the field is asked again without it.
 * - The follow, its checkpoint and the queue are saved in the plugin's store
 *   before anything is delivered, so a crash, restart or compaction neither
 *   loses nor repeats a message.
 * - A follow never stops quietly. Checks that keep failing (`stallChecks` in a
 *   row) put a note in front of the agent saying delivery has stopped and why,
 *   again every hour while they fail, and one more when delivery works again.
 *   The status line says "not delivering" meanwhile. A check that never
 *   answers is given up after `stuckMillis`. When the host refuses TalkTo's
 *   answer outright (its MCP client checks answers against the tool list it
 *   read when it connected, and a TalkTo update added a field), the follow
 *   starts again from now, and the agent is told what was skipped and how to
 *   reconnect.
 *
 * Identity: a follow names the participant explicitly (the agent's own
 * `follow` call after it registered); the MCP connection identifies nobody.
 */
import {
  capabilitiesOf,
  decodeUpdates,
  generalIdOf,
  isObject,
  isText,
  listOf,
  offerOf,
  serverNameOf,
  textOf,
  type Fields,
  type IncomingMessage,
  type ParticipantRename,
  type ToolAnswer,
  type UpdatesFailure,
  type UpdatesPage,
} from "./talkto.ts";
import {
  bodyFloor,
  bodyLimit,
  deliveryResumed,
  deliveryStalled,
  followEnded,
  isNewer,
  participantRemoved,
  queuedNotice,
  releaseText,
  replyRejected,
  saveFailed,
  stamp,
  staleConnection,
  updateNotice,
  urgentFollowUp,
  urgentNotice,
  type PluginRelease,
  type Recipient,
} from "./notice.ts";

/** When queued messages are delivered: as a turn of their own once idle, or with the person's next prompt. */
export type Delivery = "idle" | "next-prompt";
/** What urgent messages do while a turn runs: go into it, or wait like any other. */
export type UrgentHandling = "inject" | "queue";

/** Whether polls wait on the server: whenever following (the default), or never. */
export type WaitPolicy = "always" | "never";

/**
 * The wait policy a person's setting names. Anything but `never` waits: `auto`, the default before
 * 0.3.4, waited only while the session was engaged and is now the same as `always`.
 */
export const waitPolicyOf = (setting: string | undefined): WaitPolicy =>
  setting === "never" ? "never" : "always";

export interface Settings {
  readonly delivery: Delivery;
  readonly urgent: UrgentHandling;
  readonly pollMillis: number;
  readonly wait: WaitPolicy;
}

/** Arguments of a TalkTo tool call. */
export type ToolArguments = Readonly<Record<string, string | number | ReadonlyArray<string>>>;

/** What the inbox needs from the host; each plugin binds it to its engine. */
export interface Host {
  /** Calls a TalkTo MCP tool through the host's connection; rejects when the call could not be made. */
  readonly call: (tool: string, args: ToolArguments) => Promise<ToolAnswer>;
  /** Queues a turn of its own for when the session is idle; false when the engine dropped it. */
  readonly submit: (text: string) => Promise<boolean>;
  /** Appends a user row the running turn reads at its next request; false when refused. */
  readonly inject: (text: string) => Promise<boolean>;
  readonly load: () => Promise<Saved | null>;
  readonly save: (state: Saved) => Promise<void>;
  readonly now: () => Promise<number>;
  /** Runs `run` once after `ms`. */
  readonly after: (ms: number, run: () => Promise<void>) => void;
  readonly status: (text: string | undefined) => void;
  /** What the agent should do when TalkTo cannot be reached, e.g. "Check /mcp." */
  readonly connectionHint: string;
  /**
   * What the agent should do when the host's connection refuses TalkTo's answers because it was
   * set up before a TalkTo update (e.g. "Ask your person to reconnect TalkTo in /mcp.").
   * `connectionHint` when absent.
   */
  readonly reconnectHint?: string;
  /**
   * The TalkTo tools this session's connection offers, by their TalkTo names; empty when unknown.
   * Absent where the plugin connects to TalkTo itself and always has the server's current list.
   */
  readonly tools?: () => Promise<ReadonlyArray<string>>;
  /** This plugin and its version, reported to TalkTo on every get_updates call. */
  readonly plugin: PluginRelease;
}

/** A message waiting in the queue; `cut` when the queue kept only the start of its body. */
export type QueuedMessage = IncomingMessage;

/** One followed participant and its queue. */
export interface Follow extends Recipient {
  /** The channels it watches; General is added to one restored from before plugins always did. */
  channelIds: ReadonlyArray<string>;
  readonly directChats: "own" | "none";
  checkpoint: string;
  pending: QueuedMessage[];
  /** Messages that arrived while the queue was full; counted, not kept. */
  dropped: number;
  /** Renames since the last notice, at most `queueLimit`; they go with the next one. */
  renames: ParticipantRename[];
}

/** A follow as stored; one saved before renames were queued has no `renames`. */
export interface SavedFollow extends Omit<Follow, "renames"> {
  readonly renames?: ReadonlyArray<ParticipantRename>;
}

/** What the store keeps for one session. */
export interface Saved {
  readonly version: 1;
  readonly follows: ReadonlyArray<SavedFollow>;
  readonly notes: ReadonlyArray<string>;
  /** When a notice last told the agent about a plugin update; absent before the first. */
  readonly updateNoticeAt?: number;
}

/** The `follow` tool's input, decoded. */
export interface FollowInput extends Recipient {
  readonly channelIds: ReadonlyArray<string>;
  readonly directChats: "own" | "none";
  readonly startAt: "now" | "beginning";
}

/** Channels one follow may watch: TalkTo's limit for get_updates. */
export const channelLimit = 32;

/** The channels a follow watches, from the agent's choice and the server's General channel. */
export interface Watched {
  /** The chosen channels without repeats, with General added when it is known. */
  readonly channelIds: ReadonlyArray<string>;
  /** Whether General is among them. */
  readonly general: boolean;
  /** The chosen channel left out so General fits within `channelLimit`, or null. */
  readonly displaced: string | null;
}

/**
 * Adds General to the chosen channels: TalkTo announces every new channel there. With
 * `channelLimit` channels chosen and General not among them, General takes the last one's place.
 * When General is unknown (null), the choice stands as it is.
 */
export const watchedChannels = (chosen: ReadonlyArray<string>, general: string | null): Watched => {
  const unique = [...new Set(chosen)];
  if (general === null) return { channelIds: unique, general: false, displaced: null };
  if (unique.includes(general)) return { channelIds: unique, general: true, displaced: null };
  return {
    channelIds: [general, ...unique.slice(0, channelLimit - 1)],
    general: true,
    displaced: unique[channelLimit - 1] ?? null,
  };
};

/** What the follow answer says about General. */
const generalNote = (watched: Watched): string =>
  !watched.general
    ? "TalkTo did not name this server's General channel, so the plugin could not add it; to hear about new channels, add General's ID from get_context to channelIds."
    : watched.displaced === null
      ? "General is always included: TalkTo announces new channels there."
      : `General is always included and took one of the ${channelLimit} channel places, so channel ${watched.displaced} is not delivered; to keep it, follow again with at most ${channelLimit - 1} other channels.`;

/** Participants one session may follow at once (one per server). */
export const followLimit = 4;
/** Messages kept per follow; past this the oldest are counted as dropped. */
export const queueLimit = 100;
/** Pages read per follow per tick. */
const pagesPerTick = 4;
/** Idle time before a queued notice is submitted, so a person about to type goes first. */
export const settleMillis = 2000;
/** Seconds one poll may wait on the server; the most TalkTo publishes to every client. */
export const waitSeconds = 20;
/**
 * Seconds one poll asks to wait while it may. Since November 17, 2026 TalkTo lets any call that
 * names a plugin (`plugin`) wait this long, so an idle session makes about one call a minute
 * instead of three. Claude Code ends an HTTP MCP request after 60 seconds by default, which this
 * leaves room under. When TalkTo refuses it, or the host or a proxy cuts a long wait short, the
 * same check is asked again at once with `waitSeconds`, and polls wait `waitSeconds` for
 * `longWaitRetryMillis`.
 */
export const longWaitSeconds = 50;
/**
 * A long wait that fails after this long was cut short by the host or a proxy, whatever the
 * failure says: TalkTo's own failures come at once. A gateway that ends a held call may answer
 * with a body that names nothing, such as a JSON 504.
 */
export const cutMillis = 25 * 1000;
/** Long waits that fail in a row, for any reason, after which the last is taken as cut short. */
export const longWaitTries = 2;
/**
 * How long polls wait `waitSeconds` after a long wait was refused, cut short or given up; then a
 * long wait is tried again. A laptop that slept or a network that changed during one long wait
 * does not cost long waits for the whole session; a proxy that cuts every long wait costs one cut
 * call each time.
 */
export const longWaitRetryMillis = 30 * 60 * 1000;
/** Least time between the starts of two chained waiting polls, so a poll that answers at once never spins. */
export const rearmMillis = 1000;
/** Least time between two notices that mention the same plugin update. */
export const updateNoticeMillis = 24 * 60 * 60 * 1000;
/** Longest wait between polls after repeated failures. */
const backoffLimitMillis = 5 * 60 * 1000;
/** Failed checks in a row after which the agent is told that delivery has stopped. */
export const stallChecks = 3;
/** While checks keep failing, the agent is told again this often. */
export const stallRepeatMillis = 60 * 60 * 1000;
/**
 * A check still running after this long is given up and counts as failed; its answer, if it ever
 * comes, is ignored. Some hosts time out a call only after minutes, or never, and one call that
 * never answers must not stop every later check. A check that works takes at most a long wait
 * the host cuts at 60 seconds (Claude Code's limit), then the 20-second wait asked again at once:
 * this leaves 20 seconds past that. A long wait given up counts as cut short.
 */
export const stuckMillis = 100 * 1000;
/** The tools a capability brings: a connection without them was set up before the server had them. */
const capabilityTools: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["transfers", ["prepare_transfer", "complete_transfer", "fetch_transfer"]],
]);
/**
 * Failures that mean the follow can never work again as it stands: retrying them only hides the
 * problem, so the follow ends and the agent is told. `forbidden` is a participant TalkTo will not
 * deliver to, such as a person's.
 */
const permanent = new Set([
  "participant_not_found",
  "server_unavailable",
  "conversation_not_found",
  "wrong_conversation_kind",
  "invalid_input",
  "forbidden",
]);
/** A person removed the participant on the dashboard; it ends the follow with its own notice. */
const removed = "participant_removed";

/** How the agent hears about messages under these settings: the follow answer's promise. */
export const deliveryRules = (settings: Settings): string => {
  const normal =
    settings.delivery === "idle"
      ? "New messages wait in a queue and arrive as one notice after you finish a turn"
      : "New messages wait in a queue and arrive with the person's next prompt";
  const urgent =
    settings.urgent === "inject"
      ? settings.delivery === "idle"
        ? "urgent direct messages arrive inside your running turn"
        : "urgent direct messages arrive inside your running turn, or start a turn when you are idle"
      : settings.delivery === "idle"
        ? "urgent direct messages wait with the others"
        : "urgent direct messages arrive as a notice of their own once your turn ends";
  return `${normal}; ${urgent}.`;
};

/**
 * Body characters one follow's queue keeps in all; past this each new message keeps `bodyFloor`.
 * Claude Code's plugin store holds 4 MiB for every session on the machine together, so a burst of
 * long messages must not fill it: a full queue of 100 keeps at most about 172,000 characters.
 */
export const queueBodyBudget = 64_000;

/** Adds messages to a queue, each body cut to what the queue may still keep. */
const enqueue = (pending: QueuedMessage[], messages: ReadonlyArray<IncomingMessage>): void => {
  let kept = pending.reduce((sum, message) => sum + message.body.length, 0);
  for (const message of messages) {
    const limit = kept < queueBodyBudget ? bodyLimit : bodyFloor;
    const queued =
      message.body.length <= limit
        ? message
        : { ...message, body: message.body.slice(0, limit), cut: true };
    pending.push(queued);
    kept += queued.body.length;
  }
};

const same = (follow: Recipient, other: Recipient) => follow.serverId === other.serverId;

/** What one notice covered: the notes before it, the queued message IDs, and the update line. */
interface Snapshot {
  readonly notes: number;
  readonly ids: ReadonlySet<string>;
  /** When it was sent, if it carried the plugin update line. */
  readonly updateAt: number | null;
}

/** What one follow's check came to. */
type Check =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly reason: string }
  /** It was given up (`stuckMillis`, or the follow started again): nothing it read counts. */
  | { readonly kind: "abandoned" };

const ok: Check = { kind: "ok" };
const abandoned: Check = { kind: "abandoned" };

/** One follow's check in flight. */
interface Running {
  readonly serverId: string;
  /** When it started, so a check that never answers is found. */
  readonly since: number;
  /** Seconds its first page asks to wait. */
  readonly wait: number;
}

/** One follow's run of failed checks. */
interface Outage {
  readonly since: number;
  failures: number;
  reason: string;
  /** When the agent was last told; null before the first time. */
  toldAt: number | null;
}

/** Whether a failure is the host refusing TalkTo's answer against the tool list it read on connecting. */
const hostRefused = (reason: string) => /output schema|structured content/i.test(reason);

/**
 * Words of a host or proxy ending a call it held too long, whenever it does: a timeout, an abort,
 * or a gateway that answered in TalkTo's place (502, 504, an unreadable body).
 */
const cutWords = /timed? ?out|timeout|abort|gateway|\b(?:408|502|504|524)\b|unreadable body/i;

/** The words of a thrown failure and of the failures beneath it, as runtimes nest them. */
const causeWords = (cause: unknown): string => {
  const words: string[] = [];
  let current = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    words.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return words.join(" / ");
};

/** The text of a thrown failure, short enough for a notice. */
const reasonOf = (cause: unknown): string => {
  const text = (cause instanceof Error ? cause.message : String(cause)).trim();
  return (text === "" ? "the call failed without a message" : text).slice(0, 300);
};

/**
 * Waits before each new try of a save refused because the store was locked: four tries over
 * about 1.2 to 1.8 seconds. Every Claude Code session on a machine shares one plugin store, and
 * Claude Code refuses a write while another holds its lock ("Lock file is already being held").
 */
export const lockRetryMillis: ReadonlyArray<number> = [150, 350, 700];

/** Whether a save failed because another session held the store's lock. */
const lockHeld = (cause: unknown): boolean => /lock/i.test(reasonOf(cause));

/** Injected urgent messages of one turn, until a model request carries them. */
interface Injected {
  readonly turnId: string;
  readonly ids: ReadonlyArray<string>;
  stepped: boolean;
}

export class Inbox {
  private follows: Follow[] = [];
  private notes: string[] = [];
  private busy = false;
  private turnId: string | null = null;
  private idleSince = 0;
  /** False once the server rejected waitSeconds (an older deployment); polls then return at once. */
  private canWait = true;
  /** False once the server rejected the `plugin` field (a deployment before November 16, 2026). */
  private canReport = true;
  /**
   * When polls may wait `longWaitSeconds` again; until then they wait `waitSeconds`. Set
   * `longWaitRetryMillis` ahead when a long wait was refused, cut short, or given up.
   */
  private longWaitsFrom = 0;
  /** Long waits that failed in a row, for any reason; `longWaitTries` of them count as a cut. */
  private longWaitFailures = 0;
  /** The newest version of this plugin, from the latest page that said. */
  private latestVersion: string | null = null;
  /** When a notice last carried the update line; null before the first. */
  private updateNoticeAt: number | null = null;
  /** Servers whose follow's next waiting check is already arranged. */
  private readonly chained = new Set<string>();
  private submitting = false;
  /** A delivery was asked for while one ran; it runs again when that one ends. */
  private deliverAgain = false;
  private heldForInput = false;
  private injecting = false;
  private injected: Injected[] = [];
  /** When this inbox last started a turn of its own; the cadence counts from it. */
  private lastWakeAt = Number.NEGATIVE_INFINITY;
  /** Each follow's cadence from its newest page, by server; unknown until the first poll. */
  private readonly cadence = new Map<string, number>();
  /** Each server's General channel, by server, once get_context named it. */
  private readonly generals = new Map<string, string>();
  /** Servers of restored follows not yet checked for General, which plugins before 0.3.1 left out. */
  private readonly unchecked = new Set<string>();
  /**
   * A restored follow's selection with General added, by server, and the checkpoint TalkTo started
   * for it. The follow moves to it once its old checkpoint is read to the end.
   */
  private readonly widening = new Map<
    string,
    { readonly checkpoint: string; readonly channelIds: ReadonlyArray<string> }
  >();
  /** Each server's name, by server, once get_context named it; only notices use it. */
  private readonly serverNames = new Map<string, string>();
  /** Each server's capabilities, by server, from its last get_context answer. */
  private readonly capabilities = new Map<string, ReadonlyArray<string>>();
  /** Each follow's run of failed checks, by server; absent while its checks work. */
  private readonly outages = new Map<string, Outage>();
  /**
   * Each follow's check in flight, by server. A check whose entry was removed or replaced was given
   * up (it never answered, or the follow started again), and what it finds changes nothing.
   */
  private readonly running = new Map<string, Running>();
  /** Each follow's failed checks in a row and when it may check again, by server. */
  private readonly backoff = new Map<
    string,
    { readonly failures: number; readonly resumeAt: number }
  >();
  /** When each follow's checks last worked, by server; unknown before the first since a restart. */
  private readonly readAt = new Map<string, number>();
  /** Whether the agent was told that saving failed; once per session. */
  private saveFailureTold = false;
  private cadenceTimer = false;
  /** Messages the agent read itself in the running turn, with get_updates or read_messages. */
  private readInTurn = new Set<string>();
  private readonly host: Host;
  private readonly settings: Settings;

  constructor(host: Host, settings: Settings) {
    this.host = host;
    this.settings = settings;
  }

  /** Restores what this session followed and queued before a reload or restart. */
  async restore(): Promise<void> {
    const saved = await this.host.load();
    if (saved === null) return;
    this.follows = saved.follows.map((follow) => ({
      ...follow,
      pending: [...follow.pending],
      renames: [...(follow.renames ?? [])],
    }));
    for (const follow of this.follows) this.unchecked.add(follow.serverId);
    this.notes = [...saved.notes];
    this.updateNoticeAt = Number.isFinite(saved.updateNoticeAt)
      ? Number(saved.updateNoticeAt)
      : null;
    this.showStatus();
  }

  /** Starts (or restarts) delivery for one participant; the answer is what the model reads. */
  async follow(input: FollowInput): Promise<string> {
    if (this.follows.length >= followLimit && !this.follows.some((item) => same(item, input)))
      return `This session already follows ${followLimit} participants. Call unfollow for one first.`;
    const watched = watchedChannels(input.channelIds, await this.generalOf(input.serverId));
    let answer: ToolAnswer;
    try {
      answer = await this.updates(
        {
          serverId: input.serverId,
          participantId: input.participantId,
          mode: "start",
          channelIds: watched.channelIds,
          directChats: input.directChats,
          startAt: input.startAt,
          limit: 50,
        },
        0,
      );
    } catch (cause) {
      return `Could not reach TalkTo (${String(cause)}). ${this.host.connectionHint} Then call follow again.`;
    }
    const reply = decodeUpdates(answer, input.participantId);
    if (reply.kind === "failure" && reply.failure.code === removed)
      return participantRemoved(input, this.serverNames.get(input.serverId) ?? null);
    // The host checks answers against the tool list it read when it connected; a connection older
    // than TalkTo's last change refuses them, and only a reconnect helps.
    if (reply.kind === "failure" && hostRefused(reply.failure.message))
      return `Not following: this session's connection to TalkTo is older than TalkTo's last update, so it refuses TalkTo's answers (${reply.failure.message.slice(0, 160)}). ${this.reconnectHint()} Then call follow again. Until then, read your direct chats and channels with read_messages. A send that fails this way was usually stored: retry it only with the same requestKey.`;
    if (reply.kind === "failure")
      return `TalkTo refused the follow: ${reply.failure.code}: ${reply.failure.message}`;
    this.learnCadence(input.serverId, reply.page);
    this.learnLatest(reply.page);
    const follow: Follow = {
      serverId: input.serverId,
      participantId: input.participantId,
      channelIds: watched.channelIds,
      directChats: input.directChats,
      checkpoint: reply.page.checkpoint,
      pending: [],
      dropped: 0,
      renames: [...reply.page.renames],
    };
    enqueue(follow.pending, reply.page.messages);
    this.follows = [...this.follows.filter((item) => !same(item, input)), follow];
    this.unchecked.delete(input.serverId);
    this.widening.delete(input.serverId);
    this.outages.delete(input.serverId);
    // A follow restarts delivery now: its check still in flight (perhaps one that never answers)
    // is given up, and the wait after its earlier failures is dropped, so the next tick polls it
    // at once. Other follows' checks go on.
    this.running.delete(input.serverId);
    this.backoff.delete(input.serverId);
    this.readAt.set(input.serverId, await this.host.now());
    await this.persist();
    this.host.after(0, () => this.tick());
    const waiting = follow.pending.length;
    const missing = await this.missingTools(input.serverId);
    return [
      `Following participant ${input.participantId} on server ${input.serverId} (${watched.channelIds.length} channels, direct chats: ${input.directChats}).`,
      generalNote(watched),
      deliveryRules(this.settings),
      "Do not poll get_updates, create watches, or schedule checks for this participant while the plugin follows it.",
      waiting > 0 || reply.page.hasMore
        ? `${waiting}${reply.page.hasMore ? "+" : ""} earlier messages were found; they arrive ${this.settings.delivery === "idle" ? "after this turn" : "with the person's next prompt"}.`
        : "Nothing is waiting yet.",
      ...(missing.length === 0 ? [] : [staleConnection(missing, this.reconnectHint())]),
    ].join(" ");
  }

  /** What to do when the host's connection is older than TalkTo. */
  private reconnectHint(): string {
    return this.host.reconnectHint ?? this.host.connectionHint;
  }

  /**
   * The tools the server's capabilities bring that this session's connection lacks: a sign that it
   * was set up before a TalkTo update. Empty when the host cannot say.
   */
  private async missingTools(serverId: string): Promise<ReadonlyArray<string>> {
    if (this.host.tools === undefined) return [];
    let offered: ReadonlySet<string>;
    try {
      offered = new Set(await this.host.tools());
    } catch {
      return [];
    }
    if (offered.size === 0) return [];
    return (this.capabilities.get(serverId) ?? []).flatMap((capability) =>
      (capabilityTools.get(capability) ?? []).filter((name) => !offered.has(name)),
    );
  }

  /** The server's General channel, asked of get_context once per server; null when TalkTo did not say. */
  private async generalOf(serverId: string): Promise<string | null> {
    const known = this.generals.get(serverId);
    if (known !== undefined) return known;
    let answer: ToolAnswer;
    try {
      answer = await this.host.call("get_context", { serverId });
    } catch {
      return null;
    }
    this.capabilities.set(serverId, capabilitiesOf(answer));
    const name = serverNameOf(answer);
    if (name !== null) this.serverNames.set(serverId, name);
    const found = generalIdOf(answer);
    if (found !== null) this.generals.set(serverId, found);
    return found;
  }

  /** Stops delivery for the participant this session follows on one server. */
  async unfollow(serverId: string): Promise<string> {
    const found = this.follows.find((item) => item.serverId === serverId);
    if (found === undefined) return `This session does not follow anyone on server ${serverId}.`;
    this.follows = this.follows.filter((item) => item !== found);
    this.outages.delete(serverId);
    await this.persist();
    return `Stopped following participant ${found.participantId} on server ${serverId}. ${found.pending.length} queued messages were discarded; they remain in TalkTo's history.`;
  }

  /** A plain description for the person's slash command. */
  describe(): string {
    if (this.follows.length === 0)
      return "TalkTo: this session follows no participant. The agent starts delivery with the follow tool after it joins a server.";
    return this.follows
      .map(
        (item) =>
          `TalkTo: participant ${item.participantId} on server ${item.serverId}: ${item.pending.length} queued` +
          `${item.pending.some((message) => message.isUrgent) ? " (urgent waiting)" : ""}.` +
          this.outageLine(item.serverId),
      )
      .concat(
        this.settings.delivery === "idle"
          ? ["Queued messages arrive as a turn of their own when the session is idle."]
          : ["Queued messages arrive with your next prompt."],
      )
      .concat(
        this.follows.flatMap((item) => {
          const ms = this.cadence.get(item.serverId) ?? 0;
          return ms === 0
            ? []
            : [
                `On server ${item.serverId}, TalkTo starts a turn for new messages at most every ${ms >= 120_000 ? `${ms / 60_000} minutes` : `${ms / 1000} seconds`} (the wake setting on the TalkTo dashboard); urgent ones come at once.`,
              ];
        }),
      )
      .concat(
        this.updateAvailable() ? [updateNotice(this.host.plugin, this.latestVersion ?? "")] : [],
      )
      .join("\n");
  }

  onTurnStart(turnId: string): void {
    this.busy = true;
    this.turnId = turnId;
    this.heldForInput = false;
    this.readInTurn.clear();
    // Start waiting now rather than at the next timer tick, so an urgent message can reach this turn.
    this.host.after(0, () => this.tick());
  }

  onStep(turnId: string): void {
    for (const entry of this.injected) if (entry.turnId === turnId) entry.stepped = true;
  }

  /**
   * The agent read these messages itself in the running turn (a get_updates or read_messages
   * result). An injected urgent message among them needs no follow-up turn, whether the agent
   * read it before or after the injection.
   */
  onRead(turnId: string, messageIds: ReadonlyArray<string>): void {
    if (turnId !== this.turnId) return;
    for (const id of messageIds) this.readInTurn.add(id);
  }

  async onTurnComplete(turnId: string): Promise<void> {
    this.busy = false;
    this.turnId = null;
    this.idleSince = await this.host.now();
    const unread = this.injected
      .filter((entry) => entry.turnId === turnId && !entry.stepped)
      .flatMap((entry) => entry.ids)
      .filter((id) => !this.readInTurn.has(id));
    this.injected = this.injected.filter((entry) => entry.turnId !== turnId);
    this.readInTurn.clear();
    if (unread.length > 0) {
      this.notes.push(urgentFollowUp(unread));
      await this.persist();
    }
    this.host.after(settleMillis, () => this.deliver());
  }

  /**
   * For `next-prompt` delivery: everything queued, as context for the
   * person's prompt, taken out of the queue. Null when nothing waits.
   */
  async takeForPrompt(): Promise<string | null> {
    if (this.settings.delivery !== "next-prompt") return null;
    const now = await this.host.now();
    const update = this.updateDue(now);
    const text = this.noticeText(true, update);
    if (text === null) return null;
    this.clearDelivered(this.snapshot(update ? now : null));
    await this.persist();
    return text;
  }

  /**
   * One tick: check every follow that has no check in flight, each on its own. A follow's messages
   * are delivered as soon as its own check answers, so one follow's open wait never holds back
   * another's. When polls may wait, each follow's next check starts right after its last; the
   * timer is only a backstop then.
   */
  async tick(): Promise<void> {
    if (this.follows.length === 0) return;
    const now = await this.host.now();
    await Promise.all([...this.follows].map((follow) => this.check(follow, now)));
  }

  /** One follow's check: read what is new, save it, deliver what is due, then arrange the next. */
  private async check(follow: Follow, now: number): Promise<void> {
    const key = follow.serverId;
    const inFlight = this.running.get(key);
    if (inFlight !== undefined) {
      if (now - inFlight.since < stuckMillis) return;
      // The check in flight never answered: give it up, so one call that hangs cannot stop delivery.
      this.running.delete(key);
      // A host or proxy that holds a long wait without answering gets the shorter wait for a while.
      if (inFlight.wait > waitSeconds) this.stepDown(now);
      const reason = `TalkTo did not answer a check for ${Math.round((now - inFlight.since) / 1000)} seconds.`;
      this.track(follow, { kind: "failed", reason }, now);
    } else if (now < (this.backoff.get(key)?.resumeAt ?? 0)) return;
    const run: Running = { serverId: key, since: now, wait: this.waitFor(now) };
    this.running.set(key, run);
    let failed = false;
    try {
      const check = await this.poll(follow, run);
      // Given up while it ran: a newer check owns the follow now.
      if (!this.current(run)) return;
      this.track(follow, check, await this.host.now());
      failed = check.kind === "failed";
      const failures = failed ? (this.backoff.get(key)?.failures ?? 0) + 1 : 0;
      if (failures === 0) this.backoff.delete(key);
      else
        this.backoff.set(key, {
          failures,
          resumeAt: now + Math.min(backoffLimitMillis, this.settings.pollMillis * 2 ** failures),
        });
      await this.persistOrSay();
    } finally {
      if (this.current(run)) this.running.delete(key);
    }
    await this.deliver();
    if (!failed) await this.chain(key, now);
  }

  /** Whether a check is still the one its follow runs: not given up, and the follow not restarted. */
  private current(run: Running): boolean {
    return this.running.get(run.serverId) === run;
  }

  /**
   * Records how one follow's check went. Failed checks in a row tell the agent once there are
   * `stallChecks` of them and again every `stallRepeatMillis`; a working check after that says so.
   */
  private track(follow: Follow, check: Check, at: number): void {
    // A follow replaced or ended meanwhile: what its check found belongs to nobody.
    if (check.kind === "abandoned" || !this.follows.includes(follow)) return;
    const outage = this.outages.get(follow.serverId);
    if (check.kind === "ok") {
      this.readAt.set(follow.serverId, at);
      if (outage === undefined) return;
      this.outages.delete(follow.serverId);
      if (outage.toldAt !== null) this.notes.push(deliveryResumed(follow, stamp(outage.since)));
      return;
    }
    const current = outage ?? { since: at, failures: 0, reason: check.reason, toldAt: null };
    current.failures += 1;
    current.reason = check.reason;
    this.outages.set(follow.serverId, current);
    if (current.failures < stallChecks) return;
    if (current.toldAt !== null && at - current.toldAt < stallRepeatMillis) return;
    current.toldAt = at;
    const hint = hostRefused(check.reason) ? this.reconnectHint() : this.host.connectionHint;
    this.notes.push(deliveryStalled(follow, stamp(current.since), check.reason, hint));
  }

  /** The /talkto-inbox line for a follow whose checks fail; empty while they work. */
  private outageLine(serverId: string): string {
    const outage = this.outages.get(serverId);
    return outage === undefined
      ? ""
      : ` Not delivering: ${outage.failures} checks in a row failed since ${stamp(outage.since)} (${outage.reason}).`;
  }

  /** Saves; when the store refuses, says so once and lets delivery go on, which matters more. */
  private async persistOrSay(): Promise<void> {
    try {
      await this.persist();
    } catch (cause) {
      if (this.saveFailureTold) return;
      this.saveFailureTold = true;
      this.notes.push(saveFailed(reasonOf(cause)));
    }
  }

  /** Seconds a poll that starts at `now` may wait on the server. */
  private waitFor(now: number): number {
    if (!this.canWait || this.settings.wait === "never") return 0;
    // TalkTo allows a long wait only from a call that names its plugin.
    return this.canReport && now >= this.longWaitsFrom ? longWaitSeconds : waitSeconds;
  }

  /** Polls wait `waitSeconds` from `now`, and try a long wait again `longWaitRetryMillis` later. */
  private stepDown(now: number): void {
    this.longWaitFailures = 0;
    this.longWaitsFrom = now + longWaitRetryMillis;
  }

  /**
   * Whether a long wait that failed with these words was cut short by the host or a proxy, so the
   * same check is asked again at once with `waitSeconds`, and polls step down. It was when it
   * failed after `cutMillis`, whatever it says, or in a host's or proxy's words, or when it is the
   * `longWaitTries`th long wait in a row to fail. Otherwise the failure is handled as before (a
   * refused sign-in, TalkTo unavailable, a brief network drop), and long waits go on.
   */
  private cutShort(words: string, now: number, run: Running): boolean {
    this.longWaitFailures += 1;
    const cut =
      now - run.since > cutMillis || cutWords.test(words) || this.longWaitFailures >= longWaitTries;
    if (cut) this.stepDown(now);
    return cut;
  }

  /** Starts a follow's next waiting check right after its last, at most one per `rearmMillis`. */
  private async chain(serverId: string, started: number): Promise<void> {
    const now = await this.host.now();
    if (this.chained.has(serverId) || this.waitFor(now) === 0) return;
    if (!this.follows.some((follow) => follow.serverId === serverId)) return;
    this.chained.add(serverId);
    this.host.after(Math.max(0, rearmMillis - (now - started)), async () => {
      this.chained.delete(serverId);
      const follow = this.follows.find((item) => item.serverId === serverId);
      if (follow !== undefined) await this.check(follow, await this.host.now());
    });
  }

  /** One get_updates page, waiting up to `wait` seconds on the server. */
  private async page(follow: Follow, wait: number, run: Running): Promise<ToolAnswer> {
    const args = {
      serverId: follow.serverId,
      participantId: follow.participantId,
      mode: "poll",
      checkpoint: follow.checkpoint,
      limit: 50,
    } satisfies ToolArguments;
    if (wait <= waitSeconds) return this.updates(args, wait);
    // A long wait. TalkTo refusing it, and the host or a proxy cutting it short, end it the same
    // way: the check is asked again at once with the published wait, and polls step down for a
    // while. Nothing is lost: the checkpoint moves only with a page. Any other failure is handled
    // as before, and long waits go on.
    let answer: ToolAnswer;
    try {
      answer = await this.host.call("get_updates", {
        ...args,
        waitSeconds: wait,
        plugin: releaseText(this.host.plugin),
      });
    } catch (cause) {
      const words = causeWords(cause);
      if (!this.current(run) || hostRefused(words)) throw cause;
      if (!this.cutShort(words, await this.host.now(), run)) throw cause;
      return this.updates(args, waitSeconds);
    }
    const said = longWaitAnswer(answer);
    if (!this.current(run)) return answer;
    if (said.kind === "answered") {
      this.longWaitFailures = 0;
      return answer;
    }
    const now = await this.host.now();
    if (said.kind === "refused") this.stepDown(now);
    else if (!this.cutShort(said.words, now, run)) return answer;
    return this.updates(args, waitSeconds);
  }

  /**
   * One get_updates call with this plugin's name and version, and `waitSeconds` when it may wait.
   * An older server refuses fields it does not know (`invalid_input`): it is asked again without
   * `plugin`, then without `waitSeconds`, and what it refused is not sent again this session.
   */
  private async updates(args: ToolArguments, wait: number): Promise<ToolAnswer> {
    const call = (extra: ToolArguments) => this.host.call("get_updates", { ...args, ...extra });
    const waiting: ToolArguments = wait > 0 ? { waitSeconds: wait } : {};
    if (!this.canReport) return wait > 0 ? this.withoutWait(await call(waiting), call) : call({});
    const reported = await call({ ...waiting, plugin: releaseText(this.host.plugin) });
    if (!refused(reported)) return reported;
    const unreported = await call(waiting);
    if (!refused(unreported)) {
      this.canReport = false;
      return unreported;
    }
    if (wait === 0) return unreported;
    const plain = await call({});
    if (!refused(plain)) {
      // A server without waitSeconds predates the plugin field too.
      this.canWait = false;
      this.canReport = false;
    }
    return plain;
  }

  /** A server that refuses waitSeconds (an older deployment) is asked again without it. */
  private async withoutWait(
    answer: ToolAnswer,
    call: (extra: ToolArguments) => Promise<ToolAnswer>,
  ): Promise<ToolAnswer> {
    if (!refused(answer)) return answer;
    this.canWait = false;
    return call({});
  }

  /** Reads one follow's new messages into its queue. */
  private async poll(follow: Follow, run: Running): Promise<Check> {
    if (this.unchecked.has(follow.serverId)) await this.addGeneral(follow, run);
    let pages = pagesPerTick;
    for (let page = 0; page < pages; page += 1) {
      let answer: ToolAnswer;
      try {
        // Only the first page waits; a continuation already has messages to read.
        answer = await this.page(follow, page === 0 ? run.wait : 0, run);
      } catch (cause) {
        if (!this.current(run)) return abandoned;
        const reason = reasonOf(cause);
        return hostRefused(reason)
          ? this.skipRefused(follow, reason, run)
          : { kind: "failed", reason };
      }
      if (!this.current(run)) return abandoned;
      const reply = decodeUpdates(answer, follow.participantId);
      if (reply.kind === "failure")
        return answer.isError &&
          reply.failure.code === "unreadable" &&
          hostRefused(reply.failure.message)
          ? this.skipRefused(follow, reply.failure.message, run)
          : this.failed(follow, reply.failure, run);
      const known = new Set(follow.pending.map((message) => message.id));
      enqueue(
        follow.pending,
        reply.page.messages.filter((message) => !known.has(message.id)),
      );
      const over = follow.pending.length - queueLimit;
      if (over > 0) {
        follow.pending = follow.pending.slice(over);
        follow.dropped += over;
      }
      const renamed = new Set(follow.renames.map((rename) => rename.id));
      for (const rename of reply.page.renames)
        if (!renamed.has(rename.id)) follow.renames.push(rename);
      follow.renames = follow.renames.slice(-queueLimit);
      follow.checkpoint = reply.page.checkpoint;
      this.learnCadence(follow.serverId, reply.page);
      this.learnLatest(reply.page);
      if (reply.page.hasMore) continue;
      const widened = this.widening.get(follow.serverId);
      if (widened === undefined) break;
      // The old selection is read to the end: move to the one with General and read it at once,
      // while what both returned is still queued, so it is queued only once.
      this.widening.delete(follow.serverId);
      follow.checkpoint = widened.checkpoint;
      follow.channelIds = widened.channelIds;
      pages = page + 2;
    }
    return ok;
  }

  /**
   * A follow restored from a plugin before 0.3.1 may not watch General, where TalkTo announces new
   * channels. TalkTo starts the selection with General added from now; the follow moves to it once
   * its old checkpoint is read to the end, so nothing between the two is missed. A follow at the
   * channel limit, or one TalkTo refuses the wider selection for, keeps the old selection.
   */
  private async addGeneral(follow: Follow, run: Running): Promise<void> {
    this.unchecked.delete(follow.serverId);
    const general = await this.generalOf(follow.serverId);
    if (general === null || follow.channelIds.includes(general)) return;
    const watched = watchedChannels(follow.channelIds, general);
    if (watched.displaced !== null) return;
    let answer: ToolAnswer;
    try {
      answer = await this.updates(
        {
          serverId: follow.serverId,
          participantId: follow.participantId,
          mode: "start",
          channelIds: watched.channelIds,
          directChats: follow.directChats,
          startAt: "now",
          limit: 1,
        },
        0,
      );
    } catch {
      // Tried again at the next check.
      this.unchecked.add(follow.serverId);
      return;
    }
    if (!this.current(run) || !this.follows.includes(follow)) return;
    const reply = decodeUpdates(answer, follow.participantId);
    if (reply.kind === "page")
      this.widening.set(follow.serverId, {
        checkpoint: reply.page.checkpoint,
        channelIds: watched.channelIds,
      });
  }

  /** Ends a follow TalkTo will never accept again; anything else is retried. */
  private async failed(follow: Follow, failure: UpdatesFailure, run: Running): Promise<Check> {
    if (failure.code === "invalid_cursor") {
      // The server's history was restored: start again from now and say what may be missing.
      const restarted = await this.restart(follow, run);
      if (restarted.kind !== "page") return restarted.check;
      follow.checkpoint = restarted.checkpoint;
      this.notes.push(
        `TalkTo: the server's history position for participant ${follow.participantId} was reset (${failure.message}). Messages sent around the reset may not have been delivered; read recent history with read_messages.`,
      );
      return ok;
    }
    if (failure.code !== removed && !permanent.has(failure.code))
      return { kind: "failed", reason: `${failure.code}: ${failure.message}` };
    this.follows = this.follows.filter((item) => item !== follow);
    this.outages.delete(follow.serverId);
    this.notes.push(
      failure.code === removed
        ? participantRemoved(follow, await this.nameOfServer(follow.serverId))
        : followEnded(follow, `${failure.code}: ${failure.message}`),
    );
    return ok;
  }

  /** The server's name for a notice: known since its follow, or asked of get_context now. */
  private async nameOfServer(serverId: string): Promise<string | null> {
    const known = this.serverNames.get(serverId);
    if (known !== undefined) return known;
    try {
      return serverNameOf(await this.host.call("get_context", { serverId }));
    } catch {
      return null;
    }
  }

  /**
   * The host refused TalkTo's answer: its connection checks answers against the tool list it read
   * when it connected, and the page holds a field added since. Asking again from the same
   * checkpoint returns the same page forever, so start again from now (an answer with no messages
   * passes) and tell the agent what was skipped and how to reconnect.
   */
  private async skipRefused(follow: Follow, reason: string, run: Running): Promise<Check> {
    const restarted = await this.restart(follow, run);
    if (restarted.kind !== "page")
      return restarted.check.kind === "failed" ? { kind: "failed", reason } : restarted.check;
    follow.checkpoint = restarted.checkpoint;
    const since = this.readAt.get(follow.serverId);
    this.notes.push(
      replyRejected(
        follow,
        reason,
        this.reconnectHint(),
        since === undefined ? null : stamp(since),
      ),
    );
    return ok;
  }

  /** Starts one follow again from TalkTo's newest message, keeping its selection. */
  private async restart(
    follow: Follow,
    run: Running,
  ): Promise<
    | { readonly kind: "page"; readonly checkpoint: string }
    | { readonly kind: "not"; readonly check: Check }
  > {
    let answer: ToolAnswer;
    try {
      answer = await this.updates(
        {
          serverId: follow.serverId,
          participantId: follow.participantId,
          mode: "start",
          channelIds: follow.channelIds,
          directChats: follow.directChats,
          startAt: "now",
          limit: 1,
        },
        0,
      );
    } catch (cause) {
      return {
        kind: "not",
        check: this.current(run) ? { kind: "failed", reason: reasonOf(cause) } : abandoned,
      };
    }
    if (!this.current(run)) return { kind: "not", check: abandoned };
    const reply = decodeUpdates(answer, follow.participantId);
    if (reply.kind === "failure")
      return { kind: "not", check: await this.failed(follow, reply.failure, run) };
    return { kind: "page", checkpoint: reply.page.checkpoint };
  }

  /** Delivers what is due: urgent messages into a running turn, everything else once idle. */
  async deliver(): Promise<void> {
    if (this.busy && this.turnId !== null && this.settings.urgent === "inject")
      await this.injectUrgent(this.turnId);
    this.showStatus();
    if (this.busy || this.heldForInput) return;
    // One delivery at a time, claimed before the first await: deliveries started together (a tick
    // that queued a message and the settle timer of the turn that just ended) would otherwise both
    // submit the same notice. A delivery asked for meanwhile runs once the current one ends.
    if (this.submitting) {
      this.deliverAgain = true;
      return;
    }
    this.submitting = true;
    try {
      do {
        this.deliverAgain = false;
        await this.submitDue();
      } while (this.deliverAgain && !this.busy && !this.heldForInput);
    } finally {
      this.submitting = false;
      this.showStatus();
    }
  }

  /** Submits everything queued as one notice when it is due; the caller holds `submitting`. */
  private async submitDue(): Promise<void> {
    if ((await this.host.now()) - this.idleSince < settleMillis) return;
    const hasUrgent = this.follows.some((item) => item.pending.some((message) => message.isUrgent));
    // With next-prompt delivery only urgent messages wake an idle session.
    if (this.settings.delivery === "next-prompt" && !hasUrgent && this.notes.length === 0) return;
    const now = await this.host.now();
    const update = this.updateDue(now);
    const text = this.noticeText(false, update);
    if (text === null) return;
    const held = hasUrgent || this.notes.length > 0 ? 0 : this.cadenceWait(now);
    if (held > 0) {
      this.retryAfter(held);
      return;
    }
    const snapshot = this.snapshot(update ? now : null);
    try {
      if (await this.host.submit(text)) {
        this.lastWakeAt = now;
        this.clearDelivered(snapshot);
        await this.persist();
      } else this.heldForInput = true;
    } catch {
      // Not delivered: the queue is unchanged and the next tick tries again.
    }
  }

  private async injectUrgent(turnId: string): Promise<void> {
    if (this.injecting) return;
    this.injecting = true;
    try {
      await this.injectEach(turnId);
    } finally {
      this.injecting = false;
    }
  }

  private async injectEach(turnId: string): Promise<void> {
    for (const follow of this.follows) {
      const urgent = follow.pending.filter((message) => message.isUrgent);
      if (urgent.length === 0) continue;
      let accepted = false;
      try {
        accepted = await this.host.inject(urgentNotice(follow, urgent));
      } catch {
        accepted = false;
      }
      if (!accepted) continue;
      const ids = new Set(urgent.map((message) => message.id));
      follow.pending = follow.pending.filter((message) => !ids.has(message.id));
      this.injected.push({ turnId, ids: [...ids], stepped: false });
      await this.persist();
    }
  }

  /** A page without the field (an older server, or a call without `plugin`) leaves what is known. */
  private learnLatest(page: UpdatesPage): void {
    if (page.latestPluginVersion !== null) this.latestVersion = page.latestPluginVersion;
  }

  /** Whether TalkTo said a newer version of this plugin exists. */
  private updateAvailable(): boolean {
    return this.latestVersion !== null && isNewer(this.latestVersion, this.host.plugin.version);
  }

  /** Whether the next notice should carry the update line: an update exists and a day has passed. */
  private updateDue(now: number): boolean {
    return (
      this.updateAvailable() &&
      (this.updateNoticeAt === null || now - this.updateNoticeAt >= updateNoticeMillis)
    );
  }

  /** A page without the field (an older server) leaves what is known; none known means none. */
  private learnCadence(serverId: string, page: UpdatesPage): void {
    if (page.wakeIntervalSeconds !== null)
      this.cadence.set(serverId, page.wakeIntervalSeconds * 1000);
  }

  /**
   * How long the person's cadence still holds the next turn back: zero once any follow with
   * queued messages may wake, else the shortest wait among them.
   */
  private cadenceWait(now: number): number {
    const waits = this.follows
      .filter((item) => item.pending.length > 0 || item.dropped > 0)
      .map((item) => Math.max(0, this.lastWakeAt + (this.cadence.get(item.serverId) ?? 0) - now));
    return waits.length === 0 ? 0 : Math.min(...waits);
  }

  /** Tries delivery again when the cadence allows; one timer at a time. */
  private retryAfter(ms: number): void {
    if (this.cadenceTimer) return;
    this.cadenceTimer = true;
    this.host.after(ms, async () => {
      this.cadenceTimer = false;
      await this.deliver();
    });
  }

  /**
   * The combined notice for everything queued, or null when nothing waits. Queued renames go with
   * any notice; on their own they make one only when `renamesAlone` (the person's prompt carries it).
   */
  private noticeText(renamesAlone: boolean, update: boolean): string | null {
    const waking =
      this.notes.length > 0 ||
      this.follows.some((item) => item.pending.length > 0 || item.dropped > 0);
    if (!waking && !(renamesAlone && this.follows.some((item) => item.renames.length > 0)))
      return null;
    const parts = [
      ...this.notes,
      ...this.follows
        .filter((item) => item.pending.length > 0 || item.dropped > 0 || item.renames.length > 0)
        .map((item) => queuedNotice(item, item.pending, item.dropped, item.renames)),
    ];
    const text = parts.join("\n\n---\n\n");
    return update ? `${text}\n\n${updateNotice(this.host.plugin, this.latestVersion ?? "")}` : text;
  }

  /** What one notice covers, so messages and renames that arrive while it is submitted stay queued. */
  private snapshot(updateAt: number | null): Snapshot {
    return {
      updateAt,
      notes: this.notes.length,
      ids: new Set(
        this.follows.flatMap((item) => [
          ...item.pending.map((message) => message.id),
          ...item.renames.map((rename) => rename.id),
        ]),
      ),
    };
  }

  private clearDelivered(snapshot: Snapshot): void {
    if (snapshot.updateAt !== null) this.updateNoticeAt = snapshot.updateAt;
    this.notes = this.notes.slice(snapshot.notes);
    for (const follow of this.follows) {
      follow.pending = follow.pending.filter((message) => !snapshot.ids.has(message.id));
      follow.renames = follow.renames.filter((rename) => !snapshot.ids.has(rename.id));
      follow.dropped = 0;
    }
  }

  /**
   * Saves the current state. A save refused because another session holds the store's lock is
   * tried again after `lockRetryMillis`, each wait stretched by up to half at random, so sessions
   * that all saved for the same General message do not collide again. Each try saves what is
   * current then.
   */
  private async persist(): Promise<void> {
    for (const wait of [...lockRetryMillis, null]) {
      const saved: Saved = { version: 1, follows: this.follows, notes: this.notes };
      try {
        await this.host.save(
          this.updateNoticeAt === null ? saved : { ...saved, updateNoticeAt: this.updateNoticeAt },
        );
        return;
      } catch (cause) {
        if (wait === null || !lockHeld(cause)) throw cause;
      }
      await this.pause(wait * (1 + Math.random() / 2));
    }
  }

  /** Waits on the host's clock. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.host.after(ms, async () => resolve());
    });
  }

  private showStatus(): void {
    const waiting = this.follows.reduce((sum, item) => sum + item.pending.length, 0);
    const stalled = this.follows.some((item) => {
      const outage = this.outages.get(item.serverId);
      return outage !== undefined && outage.failures >= stallChecks;
    });
    this.host.status(
      this.follows.length === 0
        ? undefined
        : stalled
          ? "TalkTo: not delivering, checks fail (see /talkto-inbox)"
          : waiting === 0
            ? "TalkTo: following"
            : `TalkTo: ${waiting} queued${this.heldForInput ? " (held until you type)" : ""}`,
    );
  }
}

/**
 * What a long wait's answer says about the wait: TalkTo `answered` it (a page, or one of TalkTo's
 * own failures), TalkTo `refused` it (`invalid_input`, a server before long waits), or it `failed`
 * with the words of the host or proxy that answered in TalkTo's place. A host that refused
 * TalkTo's answer counts as answered: it would refuse a shorter wait's too, and the follow
 * restarts.
 */
const longWaitAnswer = (
  answer: ToolAnswer,
):
  | { readonly kind: "answered" }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly words: string } => {
  if (!answer.isError) return { kind: "answered" };
  const reply = decodeUpdates(answer, "");
  if (reply.kind !== "failure") return { kind: "answered" };
  const { code, message } = reply.failure;
  if (code === "invalid_input") return { kind: "refused" };
  return code !== "unreadable" || hostRefused(message)
    ? { kind: "answered" }
    : { kind: "failed", words: message };
};

/** Whether TalkTo refused a call's input (`invalid_input`), as a server older than a field does. */
const refused = (answer: ToolAnswer): boolean => {
  const reply = decodeUpdates(answer, "");
  return reply.kind === "failure" && reply.failure.code === "invalid_input";
};

const isMessage = (value: unknown): value is QueuedMessage => {
  if (!isObject(value)) return false;
  const fields: Fields = new Map(Object.entries(value));
  const transfer = fields.get("transfer");
  const cut = fields.get("cut");
  return (
    ["id", "conversationId", "senderId", "createdAt", "body", "where", "from"].every(
      (key) => textOf(fields, key) !== null,
    ) &&
    (fields.get("isUrgent") === true || fields.get("isUrgent") === false) &&
    // Absent for a whole body, and in a message saved before the queue marked cut bodies.
    (cut === undefined || cut === true || cut === false) &&
    // Absent in a message saved before offers were kept, and in one that offers nothing.
    (transfer === undefined ||
      (isObject(transfer) && offerOf(new Map(Object.entries(transfer))) !== null))
  );
};

const isRename = (value: unknown): value is ParticipantRename => {
  if (!isObject(value)) return false;
  const fields: Fields = new Map(Object.entries(value));
  const by = fields.get("by");
  const actor: Fields | null = isObject(by) ? new Map(Object.entries(by)) : null;
  return (
    ["id", "participantId", "previousName", "name"].every((key) => textOf(fields, key) !== null) &&
    (by === null ||
      (actor !== null &&
        (textOf(actor, "kind") === "self" ||
          (textOf(actor, "kind") === "person" && textOf(actor, "name") !== null))))
  );
};

const isFollow = (value: unknown): value is SavedFollow => {
  if (!isObject(value)) return false;
  const fields: Fields = new Map(Object.entries(value));
  const directChats = textOf(fields, "directChats");
  const dropped = fields.get("dropped");
  const renames = fields.get("renames");
  return (
    textOf(fields, "serverId") !== null &&
    textOf(fields, "participantId") !== null &&
    textOf(fields, "checkpoint") !== null &&
    (directChats === "own" || directChats === "none") &&
    Number.isSafeInteger(dropped) &&
    listOf(fields, "channelIds").every(isText) &&
    Array.isArray(fields.get("channelIds")) &&
    Array.isArray(fields.get("pending")) &&
    listOf(fields, "pending").every(isMessage) &&
    // Absent in a session saved before renames were queued.
    (renames === undefined || (Array.isArray(renames) && renames.every(isRename)))
  );
};

/** Whether a stored value is a session this version of the plugin saved. */
export const isSaved = (value: unknown): value is Saved => {
  if (!isObject(value)) return false;
  const fields: Fields = new Map(Object.entries(value));
  return (
    fields.get("version") === 1 &&
    Array.isArray(fields.get("follows")) &&
    listOf(fields, "follows").every(isFollow) &&
    Array.isArray(fields.get("notes")) &&
    listOf(fields, "notes").every(isText)
  );
};

/** The follow tool's arguments decoded, or what is wrong with them. */
export type FollowRead =
  | { readonly ok: true; readonly input: FollowInput }
  | { readonly ok: false; readonly problem: string };

/** Decodes the follow tool's arguments. */
export const readFollowInput = (fields: Fields): FollowRead => {
  const serverId = textOf(fields, "serverId");
  const participantId = textOf(fields, "participantId");
  const problem = (text: string): FollowRead => ({ ok: false, problem: text });
  if (serverId === null || participantId === null)
    return problem(
      "follow needs serverId and participantId: your own participant, from register_participant or get_context.",
    );
  const channels = fields.get("channelIds") ?? [];
  if (!Array.isArray(channels) || !channels.every(isText))
    return problem("channelIds must be a list of channel IDs.");
  if (new Set(channels).size > channelLimit)
    return problem(`channelIds holds at most ${channelLimit} channels.`);
  const directChats = textOf(fields, "directChats") ?? "own";
  if (directChats !== "own" && directChats !== "none")
    return problem('directChats must be "own" or "none".');
  const startAt = textOf(fields, "startAt") ?? "now";
  if (startAt !== "now" && startAt !== "beginning")
    return problem('startAt must be "now" or "beginning".');
  return {
    ok: true,
    input: { serverId, participantId, channelIds: channels, directChats, startAt },
  };
};
