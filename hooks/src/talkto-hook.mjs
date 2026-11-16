#!/usr/bin/env node
// @ts-check
// TalkTo hook entry point. Hosts run it as:
//   node talkto-hook.mjs <host> <session-start|prompt|after-tool|stop>   (hook JSON on stdin)
// and an agent whose host never shows the hook a tool result can save a link by hand:
//   node talkto-hook.mjs save <host> [--session <id>] [--cwd <dir>] <signal link>
//   node talkto-hook.mjs status|forget <host> [--session <id>] [--cwd <dir>]
// On Antigravity the agent can also start the idle watcher as a background task, which starts a
// turn while the agent is idle (only when the person asks for it):
//   node talkto-hook.mjs watch antigravity
// It always exits 0 and prints nothing on any failure: a hook must never break the agent's turn.
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fieldsOf,
  fileStore,
  fresh,
  handle,
  linkPattern,
  notices,
  settingsFrom,
  stateDirectory,
  stateKey,
  watchStep,
} from "./core.mjs";
import { hosts } from "./hosts.mjs";

/**
 * talkto-hooks' version, sent to TalkTo on each check. The release script
 * (tools/plugin-release.mjs in the TalkTo repository) sets it with the manifests; a test keeps
 * them equal.
 */
export const version = "0.3.1";

/** @type {Record<string, import("./core.mjs").HookEvent["kind"]>} */
const kinds = {
  "session-start": "sessionStart",
  prompt: "promptSubmit",
  "after-tool": "afterTool",
  stop: "stop",
};
const maximumInput = 4 * 1024 * 1024;

/** Read the host's JSON from stdin, bounded in size and time. @returns {Promise<Record<string, unknown>>} */
const readInput = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(Object.fromEntries(fieldsOf(value) ?? []));
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, 2_000);
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maximumInput) chunks.push(chunk);
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });

/** @param {ReadonlyArray<string>} args @param {string} name */
const option = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
};
const script = fileURLToPath(import.meta.url);
/** @param {string} host @param {string | null} sessionId */
const saveCommand = (host, sessionId) =>
  `node "${script}" save ${host}${sessionId === null ? "" : ` --session ${sessionId}`} '<url from create_signal>'`;

/** @param {ReadonlyArray<string>} args @param {NodeJS.ProcessEnv} env @returns {Promise<string>} */
export const run = async (args, env) => {
  const manual = args[0] === "save" || args[0] === "status" || args[0] === "forget";
  const [command, hostName] = manual ? args : [args[1], args[0]];
  const host = hostName === undefined ? undefined : hosts[hostName];
  if (command === undefined || hostName === undefined || host === undefined) return "";
  const directory = stateDirectory(env);
  if (manual) {
    const store = fileStore(
      directory,
      stateKey(hostName, option(args, "--session"), option(args, "--cwd") ?? process.cwd()),
    );
    if (command === "forget") {
      await store.forget();
      return notices.forgotten();
    }
    if (command === "status") {
      const state = await store.load();
      if (state === null) return "TalkTo: no signal link saved for this session.";
      return `TalkTo: signal link ${state.dead ? "stopped working" : "active"}, expires ${state.expiresAt ?? "unknown"}, ${state.pending} unannounced.`;
    }
    const link = args.slice(2).find((value) => linkPattern.test(value));
    const found = link === undefined ? null : linkPattern.exec(link);
    if (found === null || found[1] === undefined || found[0] !== link)
      return "TalkTo: that is not a signal link from create_signal.";
    // The agent saves by hand inside a turn.
    await store.save(fresh(found[0], found[1], null, Date.now()));
    return notices.saved();
  }
  const kind = kinds[command];
  if (kind === undefined) return "";
  const input = await readInput();
  const parsed = host.parse(kind, input, env);
  const foundLink =
    host.findLink === undefined || parsed.skip
      ? null
      : await host.findLink(kind, input).catch(() => null);
  const store = fileStore(directory, stateKey(hostName, parsed.sessionId, parsed.cwd));
  const reply = await handle(
    { ...parsed, foundLink },
    {
      ...store,
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      settings: settingsFrom(env),
      saveCommand: saveCommand(hostName, parsed.sessionId),
      quietStart: env.TALKTO_HOOKS_QUIET_START === "1",
      idleNote: host.idleNote(script),
      release: { name: "hooks", version, steps: host.updateSteps },
    },
  );
  return host.render(parsed, reply);
};

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * One watcher per session: a lock file next to the state file holds the running watcher's PID.
 * @param {string} path @returns {Promise<boolean>} Whether this process now holds it.
 */
const lock = async (path) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      return true;
    } catch {
      const holder = Number(await readFile(path, "utf8").catch(() => ""));
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return false;
      await rm(path, { force: true });
    }
  }
  return false;
};

/**
 * The idle watcher: runs until the session ends, the link dies or it is killed. Every line it
 * prints is for the agent, which reads its task's output; it prints at start and at the end only.
 * @param {ReadonlyArray<string>} args @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} say
 */
export const watch = async (args, env, say) => {
  const hostName = args[1];
  const host = hostName === undefined ? undefined : hosts[hostName];
  const watcher = host?.watcher?.(env) ?? null;
  if (host === undefined || hostName === undefined || watcher === null)
    return say(notices.watchUnsupported());
  const directory = stateDirectory(env);
  const key = stateKey(hostName, option(args, "--session") ?? watcher.sessionId, null);
  const store = fileStore(directory, key);
  if ((await store.load()) === null) return say(notices.watchNoLink());
  const lockPath = join(directory, `${key}.watch`);
  if (!(await lock(lockPath))) return say(notices.watchTwice());
  const release = () => rm(lockPath, { force: true }).catch(() => {});
  let stopped = false;
  for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
    process.on(signal, () => {
      stopped = true;
      release().finally(() => process.exit(0));
    });
  const parent = process.ppid;
  const deps = {
    ...store,
    fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => fetch(url, init),
    now: () => Date.now(),
    settings: settingsFrom(env),
    saveCommand: saveCommand(hostName, watcher.sessionId),
    quietStart: true,
    idleNote: host.idleNote(script),
    release: /** @type {const} */ ({ name: "hooks", version, steps: host.updateSteps }),
  };
  say(notices.watching());
  try {
    // The host ends its background tasks when it exits; an orphaned watcher stops by itself.
    while (!stopped && process.ppid === parent) {
      const step = await watchStep(deps);
      if (step.kind === "end") {
        if (step.notice !== null) say(step.notice);
        return;
      }
      if (step.kind === "wake" && !(await watcher.deliver(step.notice))) {
        // Exiting is the fallback: a finished background task reaches the agent too.
        say(notices.watchFailed(step.notice));
        return;
      }
      if (step.kind === "wait") await sleep(step.ms);
    }
  } finally {
    await release();
  }
};

const main = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (main && process.argv[2] === "watch")
  watch(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`))
    .catch(() => {})
    .finally(() => process.exit(0));
else if (main)
  run(process.argv.slice(2), process.env)
    .then((output) => {
      if (output !== "") process.stdout.write(`${output}\n`);
    })
    .catch(() => {})
    .finally(() => process.exit(0));
