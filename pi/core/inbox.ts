/**
 * The session's TalkTo inbox: which participants this session follows, the
 * messages waiting for it, and when they are delivered. It knows nothing about
 * the host: each plugin (Claude Code, opencode, pi) supplies a `Host`.
 *
 * Delivery model:
 * - The plugin polls TalkTo's `get_updates` through the host's authenticated
 *   connection and keeps what arrives in a queue.
 *   While the session is engaged (a turn runs, or one ended in the last ten
 *   minutes) each poll waits up to 20 seconds on the server, so a message
 *   arrives about a second after it is sent. Otherwise it checks every
 *   `pollMillis`, because an open wait keeps the TalkTo server billed.
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
 *
 * Identity: a follow names the participant explicitly (the agent's own
 * `follow` call after it registered); the MCP connection identifies nobody.
 */
import {
  decodeUpdates,
  generalIdOf,
  isObject,
  isText,
  listOf,
  textOf,
  type Fields,
  type IncomingMessage,
  type ParticipantRename,
  type ToolAnswer,
  type UpdatesFailure,
  type UpdatesPage,
} from "./talkto.ts";
import {
  bodyLimit,
  followEnded,
  isNewer,
  queuedNotice,
  releaseText,
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

/** When polls wait on the server: while engaged, whenever following, or never. */
export type WaitPolicy = "auto" | "always" | "never";

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
  /** This plugin and its version, reported to TalkTo on every get_updates call. */
  readonly plugin: PluginRelease;
}

/** A message waiting in the queue; its body is already cut to what a notice shows. */
export type QueuedMessage = IncomingMessage;

/** One followed participant and its queue. */
export interface Follow extends Recipient {
  readonly channelIds: ReadonlyArray<string>;
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
/** Seconds one poll may wait on the server; TalkTo's maximum. */
export const waitSeconds = 20;
/** How long after the last turn or message `auto` keeps waiting polls. */
export const engagedMillis = 10 * 60 * 1000;
/** Least time between the starts of two chained waiting polls, so a poll that answers at once never spins. */
export const rearmMillis = 1000;
/** Least time between two notices that mention the same plugin update. */
export const updateNoticeMillis = 24 * 60 * 60 * 1000;
/** Longest wait between polls after repeated failures. */
const backoffLimitMillis = 5 * 60 * 1000;
/** Failures that mean the follow can never work again as it stands. */
const permanent = new Set([
  "participant_not_found",
  "server_unavailable",
  "conversation_not_found",
  "wrong_conversation_kind",
  "invalid_input",
]);

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

const keep = (message: IncomingMessage): QueuedMessage =>
  message.body.length <= bodyLimit + 1
    ? message
    : // One character past the limit tells the notice the body was cut.
      { ...message, body: message.body.slice(0, bodyLimit + 1) };

const same = (follow: Recipient, other: Recipient) => follow.serverId === other.serverId;

/** What one notice covered: the notes before it, the queued message IDs, and the update line. */
interface Snapshot {
  readonly notes: number;
  readonly ids: ReadonlySet<string>;
  /** When it was sent, if it carried the plugin update line. */
  readonly updateAt: number | null;
}

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
  private activeAt = 0;
  /** False once the server rejected waitSeconds (an older deployment); polls then return at once. */
  private canWait = true;
  /** False once the server rejected the `plugin` field (a deployment before November 16, 2026). */
  private canReport = true;
  /** The newest version of this plugin, from the latest page that said. */
  private latestVersion: string | null = null;
  /** When a notice last carried the update line; null before the first. */
  private updateNoticeAt: number | null = null;
  private chained = false;
  private submitting = false;
  private heldForInput = false;
  private polling = false;
  private injecting = false;
  private failures = 0;
  private resumeAt = 0;
  private injected: Injected[] = [];
  /** When this inbox last started a turn of its own; the cadence counts from it. */
  private lastWakeAt = Number.NEGATIVE_INFINITY;
  /** Each follow's cadence from its newest page, by server; unknown until the first poll. */
  private readonly cadence = new Map<string, number>();
  /** Each server's General channel, by server, once get_context named it. */
  private readonly generals = new Map<string, string>();
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
      pending: reply.page.messages.map(keep),
      dropped: 0,
      renames: [...reply.page.renames],
    };
    this.follows = [...this.follows.filter((item) => !same(item, input)), follow];
    this.activeAt = await this.host.now();
    await this.persist();
    this.host.after(0, () => this.tick());
    const waiting = follow.pending.length;
    return [
      `Following participant ${input.participantId} on server ${input.serverId} (${watched.channelIds.length} channels, direct chats: ${input.directChats}).`,
      generalNote(watched),
      deliveryRules(this.settings),
      "Do not poll get_updates, create watches, or schedule checks for this participant while the plugin follows it.",
      waiting > 0 || reply.page.hasMore
        ? `${waiting}${reply.page.hasMore ? "+" : ""} earlier messages were found; they arrive ${this.settings.delivery === "idle" ? "after this turn" : "with the person's next prompt"}.`
        : "Nothing is waiting yet.",
    ].join(" ");
  }

  /** The server's General channel, asked of get_context once per server; null when TalkTo did not say. */
  private async generalOf(serverId: string): Promise<string | null> {
    const known = this.generals.get(serverId);
    if (known !== undefined) return known;
    let found: string | null;
    try {
      found = generalIdOf(await this.host.call("get_context", { serverId }));
    } catch {
      return null;
    }
    if (found !== null) this.generals.set(serverId, found);
    return found;
  }

  /** Stops delivery for the participant this session follows on one server. */
  async unfollow(serverId: string): Promise<string> {
    const found = this.follows.find((item) => item.serverId === serverId);
    if (found === undefined) return `This session does not follow anyone on server ${serverId}.`;
    this.follows = this.follows.filter((item) => item !== found);
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
          `${item.pending.some((message) => message.isUrgent) ? " (urgent waiting)" : ""}.`,
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
    this.activeAt = this.idleSince;
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
   * One tick: poll every follow at once, then deliver what is due. While
   * engaged, the first page of each poll waits on the server and the next
   * tick starts as soon as this one ends; the timer is only a backstop then.
   */
  async tick(): Promise<void> {
    if (this.polling || this.follows.length === 0) return;
    const now = await this.host.now();
    if (now < this.resumeAt) return;
    this.polling = true;
    let failed = false;
    try {
      const before = this.queued();
      const results = await Promise.all(
        [...this.follows].map((follow) => this.poll(follow, this.waitFor(now))),
      );
      failed = results.includes(false);
      this.failures = failed ? this.failures + 1 : 0;
      this.resumeAt = failed
        ? now + Math.min(backoffLimitMillis, this.settings.pollMillis * 2 ** this.failures)
        : 0;
      if (this.queued() > before) this.activeAt = await this.host.now();
      await this.persist();
    } finally {
      this.polling = false;
    }
    await this.deliver();
    if (!failed) await this.chain(now);
  }

  /** Seconds the next poll may wait on the server. */
  private waitFor(now: number): number {
    if (!this.canWait || this.settings.wait === "never") return 0;
    const engaged = this.busy || now - this.activeAt < engagedMillis;
    return this.settings.wait === "always" || engaged ? waitSeconds : 0;
  }

  /** Starts the next waiting poll right after this one, at most one per `rearmMillis`. */
  private async chain(started: number): Promise<void> {
    const now = await this.host.now();
    if (this.chained || this.follows.length === 0 || this.waitFor(now) === 0) return;
    this.chained = true;
    this.host.after(Math.max(0, rearmMillis - (now - started)), async () => {
      this.chained = false;
      await this.tick();
    });
  }

  private queued(): number {
    return this.follows.reduce((sum, follow) => sum + follow.pending.length, 0);
  }

  /** One get_updates page, waiting up to `wait` seconds on the server. */
  private page(follow: Follow, wait: number): Promise<ToolAnswer> {
    return this.updates(
      {
        serverId: follow.serverId,
        participantId: follow.participantId,
        mode: "poll",
        checkpoint: follow.checkpoint,
        limit: 50,
      },
      wait,
    );
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

  /** Reads one follow's new messages into its queue; false on a failure worth retrying. */
  private async poll(follow: Follow, wait: number): Promise<boolean> {
    for (let page = 0; page < pagesPerTick; page += 1) {
      let answer: ToolAnswer;
      try {
        // Only the first page waits; a continuation already has messages to read.
        answer = await this.page(follow, page === 0 ? wait : 0);
      } catch {
        return false;
      }
      const reply = decodeUpdates(answer, follow.participantId);
      if (reply.kind === "failure") return this.failed(follow, reply.failure);
      const known = new Set(follow.pending.map((message) => message.id));
      for (const message of reply.page.messages)
        if (!known.has(message.id)) follow.pending.push(keep(message));
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
      if (!reply.page.hasMore) break;
    }
    return true;
  }

  /** Ends a follow TalkTo will never accept again; anything else is retried. */
  private async failed(follow: Follow, failure: UpdatesFailure): Promise<boolean> {
    if (failure.code === "invalid_cursor") {
      // The server's history was restored: start again from now and say what may be missing.
      let restarted: ToolAnswer | null = null;
      try {
        restarted = await this.updates(
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
      } catch {
        return false;
      }
      const reply = decodeUpdates(restarted, follow.participantId);
      if (reply.kind === "failure") return this.failed(follow, reply.failure);
      follow.checkpoint = reply.page.checkpoint;
      this.notes.push(
        `TalkTo: the server's history position for participant ${follow.participantId} was reset (${failure.message}). Messages sent around the reset may not have been delivered; read recent history with read_messages.`,
      );
      return true;
    }
    if (!permanent.has(failure.code)) return false;
    this.follows = this.follows.filter((item) => item !== follow);
    this.notes.push(followEnded(follow, `${failure.code}: ${failure.message}`));
    return true;
  }

  /** Delivers what is due: urgent messages into a running turn, everything else once idle. */
  async deliver(): Promise<void> {
    if (this.busy && this.turnId !== null && this.settings.urgent === "inject")
      await this.injectUrgent(this.turnId);
    this.showStatus();
    if (this.busy || this.submitting || this.heldForInput) return;
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
    this.submitting = true;
    try {
      if (await this.host.submit(text)) {
        this.lastWakeAt = now;
        this.clearDelivered(snapshot);
        await this.persist();
      } else this.heldForInput = true;
    } catch {
      // Not delivered: the queue is unchanged and the next tick tries again.
    } finally {
      this.submitting = false;
      this.showStatus();
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

  private async persist(): Promise<void> {
    const saved: Saved = { version: 1, follows: this.follows, notes: this.notes };
    await this.host.save(
      this.updateNoticeAt === null ? saved : { ...saved, updateNoticeAt: this.updateNoticeAt },
    );
  }

  private showStatus(): void {
    const waiting = this.follows.reduce((sum, item) => sum + item.pending.length, 0);
    this.host.status(
      this.follows.length === 0
        ? undefined
        : waiting === 0
          ? "TalkTo: following"
          : `TalkTo: ${waiting} queued${this.heldForInput ? " (held until you type)" : ""}`,
    );
  }
}

/** Whether TalkTo refused a call's input (`invalid_input`), as a server older than a field does. */
const refused = (answer: ToolAnswer): boolean => {
  const reply = decodeUpdates(answer, "");
  return reply.kind === "failure" && reply.failure.code === "invalid_input";
};

const isMessage = (value: unknown): value is QueuedMessage => {
  if (!isObject(value)) return false;
  const fields: Fields = new Map(Object.entries(value));
  return (
    ["id", "conversationId", "senderId", "createdAt", "body", "where", "from"].every(
      (key) => textOf(fields, key) !== null,
    ) &&
    (fields.get("isUrgent") === true || fields.get("isUrgent") === false)
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
