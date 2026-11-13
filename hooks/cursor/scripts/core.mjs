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
 */

/**
 * @typedef {object} Counts
 * @property {number} pending
 * @property {number} urgent
 * @property {boolean} more
 * @property {string | null} cursor
 * @property {string} expiresAt
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
 */

/** @param {number} count @param {string} one @param {string} many */
const plural = (count, one, many) => (count === 1 ? one : many);
/** @param {Counts} counts */
const amount = (counts) => (counts.more ? `More than ${counts.pending}` : String(counts.pending));

/** Every line the agent can see. None carries message content: the hook has none. */
export const notices = {
  /** @param {string} saveCommand */
  setup: (saveCommand) =>
    `TalkTo hooks are installed. If you join TalkTo in this session, call create_signal right after register_participant (or recovering your participant) with your serverId, participantId and the channelIds and directChats you use for get_updates. This hook saves the link from the result and tells you when messages arrive; it never sees message text. If it does not confirm the link, save it with: ${saveCommand}`,
  saved: () =>
    "TalkTo: signal link saved for this session. You will be told here when messages arrive; then call get_updates as usual.",
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

/** @param {string} url @param {string | null} expiresAt @param {string} signalId @returns {State} */
export const fresh = (url, signalId, expiresAt) => ({
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
  return { pending, urgent, more, cursor, expiresAt };
};

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
 * @param {Pick<Dependencies, "fetch" | "now"> & { settings: Pick<Settings, "backoffMs"> }} deps
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
    const response = await deps.fetch(target.href, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${request.secret}`,
        "user-agent": "talkto-hooks/0.2",
      },
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
  return result.counts;
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
  if (event.skip) return {};
  const { settings } = deps;
  if (event.foundLink !== null && (event.kind === "afterTool" || event.kind === "stop")) {
    const link = event.foundLink;
    const live = link.expiresAt === null || Date.parse(link.expiresAt) > deps.now();
    // The same link stays saved, even once it died: the host shows the newest result every time.
    if (live && (await deps.load())?.url !== link.url) {
      await deps.save(fresh(link.url, link.signalId, link.expiresAt));
      if (event.kind === "afterTool") return { context: notices.saved() };
    }
  }
  if (event.kind === "afterTool") {
    const link = linkFrom(event.toolName, event.toolResponse);
    if (link !== null) {
      await deps.save(fresh(link.url, link.signalId, link.expiresAt));
      return { context: notices.saved() };
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
      return { context: notices.setup(deps.saveCommand) };
    return {};
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
      if (!event.stopActive) state.continuations = 0;
      if (state.continuations >= settings.maxContinuations) break;
      // Every turn end checks, whatever the interval: this is where queued messages arrive.
      const counts = await observe(state, deps, settings.stopTimeoutMs, 0);
      if (counts !== null && counts.pending > 0) {
        announce(state, counts);
        state.continuations++;
        reply = { continueWith: notices.waiting(counts) };
      } else state.continuations = 0;
      break;
    }
  }
  await deps.save(state);
  return reply;
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
});
