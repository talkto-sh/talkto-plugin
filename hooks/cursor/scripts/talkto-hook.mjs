#!/usr/bin/env node
// @ts-check
// TalkTo hook entry point. Hosts run it as:
//   node talkto-hook.mjs <host> <session-start|prompt|after-tool|stop>   (hook JSON on stdin)
// and an agent whose host never shows the hook a tool result can save a link by hand:
//   node talkto-hook.mjs save <host> [--session <id>] [--cwd <dir>] <signal link>
//   node talkto-hook.mjs status|forget <host> [--session <id>] [--cwd <dir>]
// It always exits 0 and prints nothing on any failure: a hook must never break the agent's turn.
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
} from "./core.mjs";
import { hosts } from "./hosts.mjs";

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
    await store.save(fresh(found[0], found[1], null));
    return notices.saved();
  }
  const kind = kinds[command];
  if (kind === undefined) return "";
  const parsed = host.parse(kind, await readInput(), env);
  const store = fileStore(directory, stateKey(hostName, parsed.sessionId, parsed.cwd));
  const reply = await handle(parsed, {
    ...store,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    settings: settingsFrom(env),
    saveCommand: saveCommand(hostName, parsed.sessionId),
    quietStart: env.TALKTO_HOOKS_QUIET_START === "1",
  });
  return host.render(parsed, reply);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1])
  run(process.argv.slice(2), process.env)
    .then((output) => {
      if (output !== "") process.stdout.write(`${output}\n`);
    })
    .catch(() => {})
    .finally(() => process.exit(0));
