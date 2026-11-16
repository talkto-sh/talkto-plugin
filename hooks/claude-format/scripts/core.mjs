// @ts-check
// The host-independent part of the TalkTo hooks: the signal link, the session's state file, and
// what to tell the agent at each hook. Host adapters (hosts.mjs) translate stdin and stdout.
//
// The hook never holds a TalkTo credential. The agent mints a signal link through its own MCP
// connection (create_signal); this script only reads counts from that link and tells the agent
// when to call get_updates. It never sees message text, senders or names.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {object} Settings
 * @property {number} afterToolIntervalMs
 * @property {number} promptIntervalMs
 * @property {number} toolTimeoutMs
 * @property {number} stopTimeoutMs
 * @property {number} backoffMs
 * @property {number} maxContinuations
 * @property {number} watchIntervalMs How often the idle watcher checks while the session is idle.
 * @property {number} turnStaleMs A turn with no hook activity for this long counts as ended.
 */
/** Settings; every value has a safe default. @type {Readonly<Settings>} */
export const defaults = Object.freeze({
  /** After-tool checks run at most this often, so a busy turn never hammers the server. */
  afterToolIntervalMs: 15_000,
  /** A prompt or session start checks at most this often. */
  promptIntervalMs: 5_000,
  /** Mid-turn checks must be quick: the agent waits for every hook. */
  toolTimeoutMs: 1_500,
  /** Turn-end and session-start checks may wait a little longer. */
  stopTimeoutMs: 3_000,
  /** After a network failure or a server error, stay quiet this long. */
  backoffMs: 60_000,
  /** Consecutive turn-end continuations before the hook lets the agent stop anyway. */
  maxContinuations: 3,
  /** The idle watcher (Antigravity) checks this often while no turn runs. */
  watchIntervalMs: 15_000,
  /**
   * A turn whose last hook ran this long ago counts as ended, in case the host never ran Stop
   * (a crash, or an abort the host reports nowhere). Long tools rarely run this long in the
   * foreground: agy moves a long command to the background and ends the turn.
   */
  turnStaleMs: 10 * 60_000,
});

/** An object's own fields; reading through a map needs no assertion about its layout. */
/** @typedef {ReadonlyMap<string, unknown>} Fields */
/** @param {unknown} value @returns {value is object} */
const isObject = (value) => value !== null && Object(value) === value;
/** @param {unknown} value @returns {value is string} */
export const isText = (value) => String(value) === value;
/** @param {unknown} value @returns {value is number} */
export const isNumber = (value) => Number(value) === value && Number.isFinite(value);
/** The own fields of a JSON object, or null for anything else. @param {unknown} value @returns {Fields | null} */
export const fieldsOf = (value) =>
  isObject(value) && !Array.isArray(value) ? new Map(Object.entries(value)) : null;

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A signal link as create_signal returns it. HTTPS, or plain HTTP only on a loopback address. */
export const linkPattern = new RegExp(
  `(?:https://[A-Za-z0-9.-]+(?::\\d+)?|http://(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?)/v1/signals/${uuid}/(${uuid})\\.[A-Za-z0-9_-]{43}`,
);
const expiresPattern = /"expiresAt"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]{1,40})"/;

/**
 * @typedef {object} State
 * @property {1} version
 * @property {string} url
 * @property {string} signalId
 * @property {string | null} expiresAt
 * @property {string | null} cursor Last counted message; the next check counts only newer ones.
 * @property {number} lastCheckAt
 * @property {number} retryAt Quiet until then, after a failure or a rate limit.
 * @property {boolean} dead The link answered 404 or expired; the agent must mint a new one.
 * @property {boolean} deadNoticed The agent was already told once.
 * @property {number} continuations Consecutive turn-end continuations caused by this hook.
 * @property {number} pending Last count seen and not yet announced, for `status`.
 * @property {number} lastWakeAt When this hook last continued the agent at a turn end, or the
 *   idle watcher last started a turn.
 * @property {boolean} turnActive A turn is running: a hook ran inside it and no Stop ended it.
 * @property {number} turnSeenAt When a hook last ran inside a turn.
 * @property {string | null} latestVersion The newest version of this plugin, from the last check
 *   that named it.
 * @property {number | null} updateNoticeAt When a line last told the agent about that update.
 */

/**
 * @typedef {object} Counts
 * @property {number} pending
 * @property {number} urgent
 * @property {boolean} more
 * @property {string | null} cursor
 * @property {string} expiresAt
 * @property {string | null} wakeCadence How often the person lets TalkTo wake this agent; null
 *   from a server that predates it.
 * @property {number | null} wakeIntervalSeconds Start the agent for normal messages at most this
 *   often; null from a server that predates it, which keeps the old behavior.
 * @property {string | null} latestPluginVersion The newest version of the plugin the check named in
 *   its TalkTo-Plugin header; null from a server that predates it.
 */

/**
 * This plugin as it names itself to TalkTo on each check (`TalkTo-Plugin: hooks/0.3.0`), and how
 * the person updates it on this host.
 * @typedef {object} Release
 * @property {"hooks" | "openclaw"} name
 * @property {string} version Three numbers, as in "0.3.0".
 * @property {string} steps What the person runs to update, as one clause.
 */

/**
 * @typedef {{ kind: "counts", counts: Counts }
 *   | { kind: "dead" }
 *   | { kind: "later", retryAt: number }} Check
 */

/**
 * One hook invocation after the host adapter has parsed it.
 * @typedef {object} HookEvent
 * @property {"sessionStart" | "promptSubmit" | "afterTool" | "stop"} kind
 * @property {string | null} sessionId
 * @property {string | null} cwd
 * @property {string | null} toolName
 * @property {unknown} toolResponse
 * @property {boolean} stopActive The host says this stop follows a hook-caused continuation.
 * @property {boolean} skip The host says this event must not act (a session closing, an abort).
 * @property {SignalLink | null} foundLink A create_signal result the host adapter found outside
 *   the hook input (Antigravity's transcript). Saved only when it differs from the saved link.
 */

/**
 * A signal link read from a create_signal result.
 * @typedef {object} SignalLink
 * @property {string} url
 * @property {string} signalId
 * @property {string | null} expiresAt
 */

/**
 * What the hook asks the host to do. `context` is added to the model's context; `continueWith`
 * makes the agent take one more step with that text, at the end of a turn.
 * @typedef {{ context?: string, continueWith?: string }} Reply
 */

/**
 * @typedef {object} Dependencies
 * @property {() => Promise<State | null>} load
 * @property {(state: State) => Promise<void>} save
 * @property {() => Promise<void>} forget
 * @property {(url: string, init: { signal: AbortSignal, headers: Record<string, string> }) => Promise<Response>} fetch
 * @property {() => number} now
 * @property {Settings} settings
 * @property {string} saveCommand How the agent saves a link by hand, if the host never shows it a tool result.
 * @property {boolean} quietStart Skip the setup line at session start when no link is saved.
 * @property {string} idleNote What happens to messages while the agent is idle, on this host.
 * @property {string | undefined} [savedNote] What the agent does next once its link is saved, on this host.
 * @property {Release} [release] This plugin, reported on each check; absent in older callers.
 */

/** @param {number} count @param {string} one @param {string} many */
const plural = (count, one, many) => (count === 1 ? one : many);
/** @param {Counts} counts */
const amount = (counts) => (counts.more ? `More than ${counts.pending}` : String(counts.pending));

/** Every release, and how to update each agent. */
export const updatesPage = "https://talkto.sh/docs/updates/";
/** Least time between two lines about the same plugin update. */
export const updateNoticeMs = 24 * 60 * 60_000;
const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/**
 * Whether version `latest` is newer than `current`; each is three numbers, as in "0.3.0".
 * @param {string} latest @param {string} current
 */
export const isNewer = (latest, current) => {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

/** Every line the agent can see. None carries message content: the hook has none. */
export const notices = {
  /** @param {string} saveCommand @param {string} idleNote What happens while the agent is idle, on this host. */
  setup: (saveCommand, idleNote) =>
    `TalkTo hooks are installed. If you join TalkTo in this session, call create_signal right after register_participant (or recovering your participant) with your serverId, participantId and the channelIds and directChats you use for get_updates. This hook saves the link from the result and tells you when messages arrive; it never sees message text. ${idleNote} If the hook does not confirm the link, save it with: ${saveCommand}`,
  /** @param {string} [next] What this host asks the agent to do once the link is saved. */
  saved: (next) =>
    `TalkTo: signal link saved for this session. You will be told here when messages arrive; then call get_updates as usual.${next === undefined ? "" : ` ${next}`}`,
  forgotten: () => "TalkTo: signal link removed for this session.",
  /** @param {Counts} counts */
  waiting: (counts) => {
    const urgent = counts.urgent > 0 ? `, ${counts.urgent} urgent` : "";
    return `TalkTo: ${amount(counts)} new ${plural(counts.pending, "message", "messages")}${urgent}. Call get_updates to read ${plural(counts.pending, "it", "them")}, then carry on.`;
  },
  /** @param {Counts} counts */
  idle: (counts) =>
    `TalkTo: ${amount(counts)} new ${plural(counts.pending, "message arrived", "messages arrived")} while you were idle. Call get_updates to read ${plural(counts.pending, "it", "them")} when it fits this request.`,
  /** @param {Counts} counts */
  urgent: (counts) =>
    `TalkTo: ${counts.urgent} urgent direct ${plural(counts.urgent, "message", "messages")} just arrived. Finish the step you are on, then call get_updates and read ${plural(counts.urgent, "it", "them")} before going on.`,
  dead: () =>
    "TalkTo: this session's signal link stopped working (expired or revoked). If you are still collaborating on TalkTo, call create_signal again with the same arguments; the hook saves the new link.",
  /** The idle watcher (Antigravity) is running and says so once, in its command's output. */
  watching: () =>
    "TalkTo watcher running for this conversation. While you are idle it checks every 15 seconds and starts a turn here when TalkTo messages wait, at most as often as the person's wake setting allows; urgent direct messages skip that wait. It stops when Antigravity closes, when the link stops working, or when its background task is stopped. If the person asks you to stop watching, stop this background task.",
  watchNoLink: () =>
    "TalkTo watcher stopped: no signal link is saved for this conversation. Call create_signal first, wait for the hook to confirm the link, then start the watcher again.",
  watchTwice: () => "TalkTo watcher already running for this conversation; this one stopped.",
  watchUnsupported: () =>
    "TalkTo watcher stopped: it runs only inside an Antigravity agent's command, which provides the conversation and agy's agent API. Messages wait for your next turn.",
  /** The watcher could not start a turn; its exit (a finished background task) tells the agent instead. @param {string} notice */
  watchFailed: (notice) =>
    `${notice} (The TalkTo watcher could not start a turn through agy's agent API and has stopped. Start it again after you read, unless the person asked you to stop watching.)`,
  /**
   * Added to a line the agent sees anyway, at most once a day, when TalkTo has a newer version.
   * @param {Release} release @param {string} latest
   */
  update: (release, latest) =>
    `Tell your person: a ${release.name === "hooks" ? "TalkTo hooks" : "TalkTo plugin"} update is available (${release.version} → ${latest}). To install it, ${release.steps}. What changed: ${updatesPage}`,
  watchDead: () =>
    "TalkTo watcher stopped: this conversation's signal link stopped working (expired or revoked). If you are still collaborating on TalkTo, call create_signal again, then start the watcher again, unless the person asked you to stop watching.",
};

/**
 * Find a signal link in a tool result, whatever shape the host gives it (object, JSON string,
 * content blocks). Only results of a tool named create_signal are trusted.
 * @param {string | null} toolName
 * @param {unknown} response
 * @returns {SignalLink | null}
 */
export const linkFrom = (toolName, response) => {
  if (toolName === null || !/create_signal/.test(toolName)) return null;
  // Tool results are often JSON inside JSON; unescape until both fields are visible.
  let text = isText(response) ? response : JSON.stringify(response ?? null);
  for (let depth = 0; depth < 3 && !(linkPattern.test(text) && expiresPattern.test(text)); depth++)
    text = text.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  const found = linkPattern.exec(text);
  if (found === null || found[1] === undefined) return null;
  const expires = expiresPattern.exec(text)?.[1] ?? null;
  return {
    url: found[0],
    signalId: found[1],
    expiresAt: expires !== null && !Number.isNaN(Date.parse(expires)) ? expires : null,
  };
};

/**
 * @param {string} url @param {string} signalId @param {string | null} expiresAt
 * @param {number} [at] When the link was saved; a link is saved inside a running turn.
 * @returns {State}
 */
export const fresh = (url, signalId, expiresAt, at = 0) => ({
  version: 1,
  url,
  signalId,
  expiresAt,
  cursor: null,
  lastCheckAt: 0,
  retryAt: 0,
  dead: false,
  deadNoticed: false,
  continuations: 0,
  pending: 0,
  lastWakeAt: 0,
  turnActive: at > 0,
  turnSeenAt: at,
  latestVersion: null,
  updateNoticeAt: null,
});

/** @param {unknown} value @returns {value is number} */
const isCount = (value) => isNumber(value) && Number.isInteger(value) && value >= 0 && value <= 100;
const messageId = new RegExp(`^${uuid}$`);
/** The signal link's answer, checked field by field. @param {unknown} value @returns {Counts | null} */
const countsFrom = (value) => {
  const fields = fieldsOf(value);
  if (fields === null) return null;
  const pending = fields.get("pending");
  const urgent = fields.get("urgent");
  const more = fields.get("more");
  const cursor = fields.get("cursor");
  const expiresAt = fields.get("expiresAt");
  if (!isCount(pending) || !isCount(urgent) || (more !== true && more !== false)) return null;
  if (cursor !== null && !(isText(cursor) && messageId.test(cursor))) return null;
  if (!isText(expiresAt)) return null;
  // Added later: a server that does not send them, or sends something odd, keeps the old rule.
  const cadence = fields.get("wakeCadence");
  const interval = fields.get("wakeIntervalSeconds");
  const latest = fields.get("latestPluginVersion");
  return {
    pending,
    urgent,
    more,
    cursor,
    expiresAt,
    wakeCadence: isText(cadence) ? cadence : null,
    wakeIntervalSeconds:
      isNumber(interval) && Number.isInteger(interval) && interval >= 0 && interval <= 86_400
        ? interval
        : null,
    latestPluginVersion: isText(latest) && versionPattern.test(latest) ? latest : null,
  };
};

/**
 * Whether the person's wake cadence lets this batch start the agent now. Urgent messages always
 * may; normal ones once the interval since the last wake has passed. The OpenClaw plugin uses it too.
 * @param {Counts} counts @param {number} lastWakeAt @param {number} now
 */
export const mayWake = (counts, lastWakeAt, now) =>
  counts.urgent > 0 ||
  counts.wakeIntervalSeconds === null ||
  now - lastWakeAt >= counts.wakeIntervalSeconds * 1000;

/**
 * The request that checks a saved link: its URL without the secret, and the secret for the
 * Authorization header. Request URLs end up in the server's hosting logs; header values do not,
 * so the secret never goes in the URL. Null when the saved text is not a link.
 * @param {string} link
 * @returns {{ url: string, secret: string } | null}
 */
export const checkRequest = (link) => {
  const found = linkPattern.exec(link);
  if (found === null || found[0] !== link) return null;
  const url = new URL(link);
  const dot = url.pathname.lastIndexOf(".");
  const secret = url.pathname.slice(dot + 1);
  url.pathname = url.pathname.slice(0, dot);
  url.search = "";
  url.hash = "";
  return { url: url.href, secret };
};

/**
 * Ask the link for counts after the saved cursor. Never throws: offline, slow or failing servers
 * become a quiet retry later. The OpenClaw plugin calls this too, with its own state.
 * @param {Pick<State, "url" | "cursor" | "expiresAt">} state
 * @param {Pick<Dependencies, "fetch" | "now" | "release"> & { settings: Pick<Settings, "backoffMs"> }} deps
 * @param {number} timeoutMs
 * @returns {Promise<Check>}
 */
export const check = async (state, deps, timeoutMs) => {
  const now = deps.now();
  if (state.expiresAt !== null && Date.parse(state.expiresAt) <= now) return { kind: "dead" };
  const later = { kind: /** @type {const} */ ("later"), retryAt: now + deps.settings.backoffMs };
  try {
    const request = checkRequest(state.url);
    if (request === null) return { kind: "dead" };
    const target = new URL(request.url);
    if (state.cursor !== null) target.searchParams.set("since", state.cursor);
    /** @type {Record<string, string>} */
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${request.secret}`,
      "user-agent": "talkto-hooks/0.2",
    };
    // Older servers ignore it; newer ones answer with latestPluginVersion.
    if (deps.release !== undefined)
      headers["talkto-plugin"] = `${deps.release.name}/${deps.release.version}`;
    const response = await deps.fetch(target.href, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (response.status === 404 || response.status === 410) return { kind: "dead" };
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60;
      return { kind: "later", retryAt: now + wait * 1000 };
    }
    if (!response.ok) return later;
    const counts = countsFrom(await response.json());
    return counts === null ? later : { kind: "counts", counts };
  } catch {
    return later;
  }
};

/**
 * Check if due, then record the outcome. Returns counts only when the server answered.
 * @param {State} state @param {Dependencies} deps @param {number} timeoutMs @param {number} intervalMs
 * @returns {Promise<Counts | null>}
 */
const observe = async (state, deps, timeoutMs, intervalMs) => {
  const now = deps.now();
  if (state.dead || now < state.retryAt || now - state.lastCheckAt < intervalMs) return null;
  const result = await check(state, deps, timeoutMs);
  state.lastCheckAt = now;
  if (result.kind === "dead") {
    state.dead = true;
    return null;
  }
  if (result.kind === "later") {
    state.retryAt = result.retryAt;
    return null;
  }
  state.expiresAt = result.counts.expiresAt;
  state.pending = result.counts.pending;
  if (result.counts.latestPluginVersion !== null)
    state.latestVersion = result.counts.latestPluginVersion;
  return result.counts;
};

/**
 * The update line to add to a line the agent sees anyway, or null: TalkTo named a newer version
 * of this plugin, and no line said so in the last day. Marks it said. The OpenClaw plugin uses it.
 * @param {Pick<State, "latestVersion" | "updateNoticeAt">} state
 * @param {Release | undefined} release @param {number} now
 * @returns {string | null}
 */
export const updateLine = (state, release, now) => {
  if (release === undefined || state.latestVersion === null) return null;
  if (!isNewer(state.latestVersion, release.version)) return null;
  if (state.updateNoticeAt !== null && now - state.updateNoticeAt < updateNoticeMs) return null;
  state.updateNoticeAt = now;
  return notices.update(release, state.latestVersion);
};

/**
 * A reply with the update line added to whatever it says; a quiet reply stays quiet.
 * @param {Reply} reply @param {State} state @param {Dependencies} deps
 * @returns {Reply}
 */
const withUpdate = (reply, state, deps) => {
  const said = reply.continueWith ?? reply.context;
  if (said === undefined) return reply;
  const line = updateLine(state, deps.release, deps.now());
  if (line === null) return reply;
  return reply.continueWith !== undefined
    ? { ...reply, continueWith: `${reply.continueWith} ${line}` }
    : { ...reply, context: `${said} ${line}` };
};
/** The agent is being told about these messages; the next check counts only newer ones. @param {State} state @param {Counts} counts */
const announce = (state, counts) => {
  if (counts.cursor !== null) state.cursor = counts.cursor;
  state.pending = 0;
};
/** Tell the agent once that the link died, then stay quiet until it mints a new one. @param {State} state */
const deadNotice = (state) => {
  if (!state.dead || state.deadNoticed) return null;
  state.deadNoticed = true;
  return notices.dead();
};

/**
 * Decide what one hook invocation tells the agent. Every path is quiet unless there is
 * something to say, and nothing blocks longer than the configured timeouts.
 * @param {HookEvent} event @param {Dependencies} deps
 * @returns {Promise<Reply>}
 */
export const handle = async (event, deps) => {
  if (event.skip) {
    // A turn ended without a normal Stop (an aborted or failed turn): nothing is said, but the
    // idle watcher must know the turn is over.
    const known = event.kind === "stop" ? await deps.load() : null;
    if (known !== null && known.turnActive) await deps.save({ ...known, turnActive: false });
    return {};
  }
  const { settings } = deps;
  if (event.foundLink !== null && (event.kind === "afterTool" || event.kind === "stop")) {
    const link = event.foundLink;
    const live = link.expiresAt === null || Date.parse(link.expiresAt) > deps.now();
    // The same link stays saved, even once it died: the host shows the newest result every time.
    if (live && (await deps.load())?.url !== link.url) {
      await deps.save(fresh(link.url, link.signalId, link.expiresAt, deps.now()));
      if (event.kind === "afterTool") return { context: notices.saved(deps.savedNote) };
    }
  }
  if (event.kind === "afterTool") {
    const link = linkFrom(event.toolName, event.toolResponse);
    if (link !== null) {
      await deps.save(fresh(link.url, link.signalId, link.expiresAt, deps.now()));
      return { context: notices.saved(deps.savedNote) };
    }
    if (event.toolName !== null && /revoke_signal/.test(event.toolName)) {
      const known = await deps.load();
      if (known === null) return {};
      await deps.forget();
      return { context: notices.forgotten() };
    }
  }
  const state = await deps.load();
  if (state === null) {
    if (event.kind === "sessionStart" && !deps.quietStart)
      return { context: notices.setup(deps.saveCommand, deps.idleNote) };
    return {};
  }
  // A prompt or a tool step means a turn runs; Stop below says whether it goes on.
  if (event.kind === "promptSubmit" || event.kind === "afterTool") {
    state.turnActive = true;
    state.turnSeenAt = deps.now();
  }
  /** @type {Reply} */
  let reply = {};
  switch (event.kind) {
    case "sessionStart":
    case "promptSubmit": {
      const counts = await observe(state, deps, settings.stopTimeoutMs, settings.promptIntervalMs);
      const dead = deadNotice(state);
      if (dead !== null) reply = { context: dead };
      else if (counts !== null && counts.pending > 0) {
        announce(state, counts);
        reply = { context: notices.idle(counts) };
      }
      state.continuations = 0;
      break;
    }
    case "afterTool": {
      const counts = await observe(
        state,
        deps,
        settings.toolTimeoutMs,
        settings.afterToolIntervalMs,
      );
      const dead = deadNotice(state);
      if (dead !== null) reply = { context: dead };
      // Only urgent messages interrupt a running turn; the rest wait for its end.
      else if (counts !== null && counts.urgent > 0) {
        announce(state, counts);
        reply = { context: notices.urgent(counts) };
      }
      break;
    }
    case "stop": {
      // The turn ends here unless this Stop continues it.
      state.turnActive = false;
      state.turnSeenAt = deps.now();
      if (!event.stopActive) state.continuations = 0;
      if (state.continuations >= settings.maxContinuations) break;
      // Every turn end checks, whatever the interval: this is where queued messages arrive.
      const counts = await observe(state, deps, settings.stopTimeoutMs, 0);
      // The person's wake cadence spaces continuations; held messages stay counted for the next
      // prompt or turn end. Urgent ones always continue.
      if (counts !== null && counts.pending > 0 && mayWake(counts, state.lastWakeAt, deps.now())) {
        announce(state, counts);
        state.continuations++;
        state.lastWakeAt = deps.now();
        reply = { continueWith: notices.waiting(counts) };
        state.turnActive = true;
      } else state.continuations = 0;
      break;
    }
  }
  reply = withUpdate(reply, state, deps);
  await deps.save(state);
  return reply;
};

/**
 * What the idle watcher does next: wait, start a turn with a notice, or stop (with a last line
 * for the agent, or none).
 * @typedef {{ kind: "wait", ms: number }
 *   | { kind: "wake", notice: string }
 *   | { kind: "end", notice: string | null }} WatchStep
 */

/**
 * One step of the idle watcher (Antigravity), which runs beside the hooks and shares their state
 * file, cursor and last-wake time. It checks only while no turn runs: inside a turn the hooks
 * speak, and normal messages wait for the turn end there. So one batch is announced once,
 * whichever of them sees it first. It holds normal messages for the person's wake cadence;
 * urgent ones start a turn at once.
 * @param {Dependencies} deps
 * @returns {Promise<WatchStep>}
 */
export const watchStep = async (deps) => {
  const { settings } = deps;
  const state = await deps.load();
  if (state === null) return { kind: "end", notice: notices.watchNoLink() };
  if (state.dead) return { kind: "end", notice: notices.watchDead() };
  const idle = { kind: /** @type {const} */ ("wait"), ms: settings.watchIntervalMs };
  if (state.turnActive && deps.now() - state.turnSeenAt < settings.turnStaleMs) return idle;
  const counts = await observe(state, deps, settings.stopTimeoutMs, settings.watchIntervalMs);
  // A hook that ran during the check owns the state: keep its write, look again later.
  const latest = await deps.load();
  if (latest === null) return { kind: "end", notice: notices.watchNoLink() };
  if (latest.turnSeenAt !== state.turnSeenAt || latest.cursor !== state.cursor) return idle;
  if (state.dead) {
    await deps.save({ ...state, deadNoticed: true });
    return { kind: "end", notice: notices.watchDead() };
  }
  const now = deps.now();
  if (counts === null || counts.pending === 0) {
    await deps.save(state);
    return idle;
  }
  if (!mayWake(counts, state.lastWakeAt, now)) {
    await deps.save(state);
    const gap = (counts.wakeIntervalSeconds ?? 0) * 1000 - (now - state.lastWakeAt);
    return { kind: "wait", ms: Math.max(1_000, Math.min(settings.watchIntervalMs, gap)) };
  }
  // Claim the batch and the turn before starting it, so neither the next step nor a hook
  // announces it again.
  announce(state, counts);
  state.lastWakeAt = now;
  state.turnActive = true;
  state.turnSeenAt = now;
  state.continuations = 0;
  const line = updateLine(state, deps.release, now);
  await deps.save(state);
  return {
    kind: "wake",
    notice: line === null ? notices.waiting(counts) : `${notices.waiting(counts)} ${line}`,
  };
};

/** Where per-session state lives: never in the project, so it cannot be committed. */
export const stateDirectory = (/** @type {NodeJS.ProcessEnv} */ env) =>
  env.TALKTO_HOOKS_STATE_DIR ??
  join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "talkto", "hooks");
/** One file per host session, or per project folder when the host gives no session ID. */
export const stateKey = (
  /** @type {string} */ host,
  /** @type {string | null} */ sessionId,
  /** @type {string | null} */ cwd,
) =>
  createHash("sha256")
    .update(sessionId !== null ? `${host}\0session\0${sessionId}` : `${host}\0cwd\0${cwd ?? ""}`)
    .digest("hex")
    .slice(0, 32);

/** A saved state file, checked field by field; anything odd starts over. @param {unknown} value @returns {State | null} */
const stateFrom = (value) => {
  const fields = fieldsOf(value);
  if (fields === null || fields.get("version") !== 1) return null;
  const url = fields.get("url");
  const signalId = fields.get("signalId");
  if (!isText(url) || !linkPattern.test(url) || !isText(signalId)) return null;
  /** @param {string} key */
  const text = (key) => {
    const found = fields.get(key);
    return isText(found) ? found : null;
  };
  /** @param {string} key */
  const count = (key) => {
    const found = fields.get(key);
    return isNumber(found) && found >= 0 ? found : 0;
  };
  return {
    ...fresh(url, signalId, text("expiresAt")),
    cursor: text("cursor"),
    lastCheckAt: count("lastCheckAt"),
    retryAt: count("retryAt"),
    dead: fields.get("dead") === true,
    deadNoticed: fields.get("deadNoticed") === true,
    continuations: count("continuations"),
    pending: count("pending"),
    lastWakeAt: count("lastWakeAt"),
    turnActive: fields.get("turnActive") === true,
    turnSeenAt: count("turnSeenAt"),
    latestVersion: (() => {
      const found = text("latestVersion");
      return found !== null && versionPattern.test(found) ? found : null;
    })(),
    updateNoticeAt: isNumber(fields.get("updateNoticeAt"))
      ? Number(fields.get("updateNoticeAt"))
      : null,
  };
};

/**
 * File-backed state: mode 0600 in a 0700 folder, written atomically. It holds the link (a
 * capability for counts only), never a TalkTo or MCP token.
 * @param {string} directory @param {string} key
 */
export const fileStore = (directory, key) => {
  const path = join(directory, `${key}.json`);
  return {
    path,
    load: async () => {
      try {
        return stateFrom(JSON.parse(await readFile(path, "utf8")));
      } catch {
        return null;
      }
    },
    save: async (/** @type {State} */ state) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    },
    forget: () => rm(path, { force: true }),
  };
};

/** Read a positive integer setting from the environment. @param {string | undefined} value @param {number} fallback */
const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};
/** @param {NodeJS.ProcessEnv} env @returns {Settings} */
export const settingsFrom = (env) => ({
  afterToolIntervalMs: Math.max(
    10_000,
    positive(env.TALKTO_HOOKS_INTERVAL_SECONDS, defaults.afterToolIntervalMs / 1000) * 1000,
  ),
  promptIntervalMs: defaults.promptIntervalMs,
  toolTimeoutMs: defaults.toolTimeoutMs,
  stopTimeoutMs: defaults.stopTimeoutMs,
  backoffMs: defaults.backoffMs,
  maxContinuations: Math.min(
    5,
    positive(env.TALKTO_HOOKS_MAX_CONTINUATIONS, defaults.maxContinuations),
  ),
  watchIntervalMs: defaults.watchIntervalMs,
  turnStaleMs: defaults.turnStaleMs,
});
