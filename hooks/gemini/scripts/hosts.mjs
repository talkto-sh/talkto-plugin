// @ts-check
// Thin per-host adapters: parse a host's hook input into a HookEvent, and render a Reply as that
// host's documented output. Sources are listed in the README, per host.

import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fieldsOf, isNumber, isText, linkPattern } from "./core.mjs";

/** @typedef {import("./core.mjs").HookEvent} HookEvent */
/** @typedef {import("./core.mjs").Reply} Reply */
/** @typedef {import("./core.mjs").SignalLink} SignalLink */
/** @typedef {import("./core.mjs").Fields} Fields */
/** @typedef {HookEvent["kind"]} Kind */

/**
 * @typedef {object} Host
 * @property {string} name
 * @property {(kind: Kind, input: Record<string, unknown>, env: NodeJS.ProcessEnv) => HookEvent} parse
 * @property {(event: HookEvent, reply: Reply) => string} render JSON for stdout, or "" for nothing.
 * @property {(kind: Kind, input: Record<string, unknown>) => Promise<SignalLink | null>} [findLink]
 *   For a host whose hook input never carries the tool result: find the newest create_signal
 *   result some other way. It may throw; the caller treats that as nothing found.
 * @property {string} updateSteps How the person installs a talkto-hooks update on this host, as
 *   one clause after "To install it,".
 * @property {(script: string) => string} idleNote The session-start sentence on what happens to
 *   messages while the agent is idle on this host. It must say only what this host really does.
 * @property {(script: string) => string} [savedNote] What the agent does next once the hook
 *   saved its link, added to the confirmation.
 * @property {(env: NodeJS.ProcessEnv) => Watcher | null} [watcher] For a host where a process
 *   beside the session can start a turn in it: how, from the environment the host gives the
 *   agent's commands. Null when that environment is missing.
 */

/**
 * @typedef {object} Watcher
 * @property {string} sessionId The session the watcher serves, as the hooks key it.
 * @property {(notice: string) => Promise<boolean>} deliver Start a turn with the notice; false
 *   when the host refused or could not be reached.
 */

/** Hosts whose hooks only run inside a turn: nothing can start one while the agent is idle. */
const turnOnly = () =>
  "While you are idle, nothing here can start a turn: messages that arrive then wait until your next turn.";

/** @param {unknown} value @returns {string | null} */
const text = (value) => (isText(value) && value.length > 0 ? value : null);
/** @param {Record<string, unknown>} input @param {ReadonlyArray<string>} keys */
const first = (input, keys) => {
  for (const key of keys) {
    const value = text(input[key]);
    if (value !== null) return value;
  }
  return null;
};
/** @param {Kind} kind @param {Partial<HookEvent>} fields @returns {HookEvent} */
const event = (kind, fields) => ({
  kind,
  sessionId: null,
  cwd: null,
  toolName: null,
  toolResponse: null,
  stopActive: false,
  skip: false,
  foundLink: null,
  ...fields,
});

/** Claude Code's hook names, which Codex, Droid, Grok Build and Devin share. */
const claudeEvents = /** @type {const} */ ({
  sessionStart: "SessionStart",
  promptSubmit: "UserPromptSubmit",
  afterTool: "PostToolUse",
  stop: "Stop",
});
/** @param {HookEvent} hook @param {Reply} reply */
const claudeRender = (hook, reply) => {
  if (hook.kind === "stop")
    return reply.continueWith === undefined
      ? ""
      : JSON.stringify({ decision: "block", reason: reply.continueWith });
  if (reply.context === undefined) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: claudeEvents[hook.kind],
      additionalContext: reply.context,
    },
  });
};

/**
 * Claude Code's hook format, as loaded from a Claude-format plugin by Codex, Droid, Grok Build
 * and Devin. Grok sends camelCase keys with snake_case aliases, and also fires Stop when a
 * session closes (reason channel_closed or shutdown): those must not continue anything.
 * @type {Host}
 */
export const claude = {
  name: "claude",
  updateSteps:
    "run `devin plugins update talkto-hooks` in Devin, `droid plugin marketplace update talkto-plugin` then `droid plugin update talkto-hooks@talkto-plugin --scope user` in Droid, or `grok plugin update talkto-hooks` in Grok Build, then start a new session",
  parse: (kind, input, env) =>
    event(kind, {
      sessionId: first(input, ["session_id", "sessionId"]),
      cwd:
        first(input, ["cwd", "workspaceRoot"]) ??
        text(env.DEVIN_PROJECT_DIR) ??
        text(env.CLAUDE_PROJECT_DIR),
      toolName: first(input, ["tool_name", "toolName"]),
      toolResponse: input.tool_response ?? input.toolResponse ?? null,
      stopActive: input.stop_hook_active === true || input.stopHookActive === true,
      skip:
        kind === "stop" &&
        isText(input.reason) &&
        input.reason !== "end_turn" &&
        input.reason !== "",
    }),
  render: claudeRender,
  idleNote: turnOnly,
};

/** Codex uses Claude Code's format, with no continuation cap of its own; core caps it. */
export const codex = {
  ...claude,
  name: "codex",
  updateSteps:
    "run `codex plugin marketplace upgrade talkto`, then start a new session (Codex also upgrades it when it starts)",
};

/**
 * Cursor's native hooks (`.cursor-plugin`). Stop continues with `followup_message`, submitted as
 * the next user message; only a completed turn continues. postToolUse and sessionStart take
 * `additional_context`. Cursor has no prompt-time context, so promptSubmit is not installed.
 * @type {Host}
 */
export const cursor = {
  name: "cursor",
  updateSteps:
    "reload the Cursor window, since Cursor updates installed plugins when it starts; a copied folder needs the new hooks/cursor copied first",
  idleNote: turnOnly,
  parse: (kind, input) => {
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
    return event(kind, {
      sessionId: first(input, ["conversation_id", "session_id"]),
      cwd: first(input, ["cwd"]) ?? text(roots[0]),
      toolName: first(input, ["tool_name"]),
      toolResponse: input.tool_output ?? input.result_json ?? null,
      stopActive: isNumber(input.loop_count) && input.loop_count > 0,
      skip: kind === "stop" && input.status !== undefined && input.status !== "completed",
    });
  },
  render: (hook, reply) => {
    if (hook.kind === "stop")
      return reply.continueWith === undefined
        ? ""
        : JSON.stringify({ followup_message: reply.continueWith });
    return reply.context === undefined ? "" : JSON.stringify({ additional_context: reply.context });
  },
};

/**
 * GitHub Copilot's shared harness (Copilot CLI, and VS Code sessions whose target is Copilot),
 * configured with camelCase events, so fields arrive in camelCase. Stop takes Claude's
 * decision/reason; context is a top-level `additionalContext`.
 * @type {Host}
 */
export const copilot = {
  name: "copilot",
  updateSteps:
    "run `copilot plugin update talkto-hooks` in Copilot CLI, or Chat: Update Plugins in VS Code, then start a new session",
  idleNote: turnOnly,
  parse: (kind, input) => {
    const result = input.toolResult ?? input.tool_result;
    const stopReason = input.stopReason ?? input.stop_reason;
    return event(kind, {
      sessionId: first(input, ["sessionId", "session_id"]),
      cwd: first(input, ["cwd"]),
      toolName: first(input, ["toolName", "tool_name"]),
      toolResponse: result ?? null,
      stopActive: input.stop_hook_active === true || input.stopHookActive === true,
      skip: kind === "stop" && isText(stopReason) && stopReason !== "end_turn",
    });
  },
  render: (hook, reply) => {
    if (hook.kind === "stop")
      return reply.continueWith === undefined
        ? ""
        : JSON.stringify({ decision: "block", reason: reply.continueWith });
    return reply.context === undefined ? "" : JSON.stringify({ additionalContext: reply.context });
  },
};

/**
 * Gemini CLI extensions. AfterAgent continues with decision "deny" (its reason is sent as a new
 * prompt); SessionStart, BeforeAgent and AfterTool take `hookSpecificOutput.additionalContext`.
 * @type {Host}
 */
export const gemini = {
  name: "gemini",
  updateSteps:
    "run `git pull` in your clone of talkto-sh/talkto-plugin, then `gemini extensions update talkto-hooks`, then restart Gemini CLI",
  idleNote: turnOnly,
  parse: (kind, input, env) =>
    event(kind, {
      sessionId: first(input, ["session_id"]) ?? text(env.GEMINI_SESSION_ID),
      cwd: first(input, ["cwd"]) ?? text(env.GEMINI_CWD) ?? text(env.GEMINI_PROJECT_DIR),
      toolName: first(input, ["tool_name", "original_request_name"]),
      toolResponse: input.tool_response ?? null,
      stopActive: input.stop_hook_active === true,
    }),
  render: (hook, reply) => {
    if (hook.kind === "stop")
      return reply.continueWith === undefined
        ? ""
        : JSON.stringify({ decision: "deny", reason: reply.continueWith });
    return reply.context === undefined
      ? ""
      : JSON.stringify({ hookSpecificOutput: { additionalContext: reply.context } });
  },
};

/**
 * A value as an Antigravity transcript records it: agy 1.5.7's transcript.jsonl JSON-encodes each
 * tool argument, and its transcript_full.jsonl does not.
 * @param {unknown} value @returns {string | null}
 */
const recorded = (value) => {
  if (!isText(value)) return null;
  try {
    return text(JSON.parse(value));
  } catch {
    return text(value);
  }
};
/** The tool that a transcript tool call ran. MCP calls are `call_mcp_tool` with `ToolName` in args. @param {unknown} call */
const calledTool = (call) => {
  const fields = fieldsOf(call);
  if (fields === null) return null;
  return recorded(fieldsOf(fields.get("args"))?.get("ToolName")) ?? text(fields.get("name"));
};
const createSignal = /(?:^|[^A-Za-z0-9])create_signal$/;
/** Steps that can follow a tool call but are not a tool's result. */
const notResults = new Set(["EPHEMERAL_MESSAGE", "SYSTEM_MESSAGE"]);
/** Steps after the results of a model step's tool calls. */
const nextTurn = new Set(["PLANNER_RESPONSE", "USER_INPUT"]);

/**
 * The signal link in one recorded create_signal result. Its content is some header lines, then
 * the tool's JSON. Only the `data.url` field counts, and its signal ID must equal `data.signalId`.
 * @param {unknown} content @returns {SignalLink | null}
 */
const resultLink = (content) => {
  if (!isText(content)) return null;
  const start = content.search(/^\{/m);
  if (start === -1) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(content.slice(start));
  } catch {
    return null;
  }
  const data = fieldsOf(fieldsOf(parsed)?.get("data"));
  const url = data?.get("url");
  const signalId = data?.get("signalId");
  const expiresAt = data?.get("expiresAt");
  if (!isText(url) || !isText(signalId)) return null;
  const found = linkPattern.exec(url);
  if (found === null || found[0] !== url || found[1] !== signalId) return null;
  return {
    url,
    signalId,
    expiresAt: isText(expiresAt) && !Number.isNaN(Date.parse(expiresAt)) ? expiresAt : null,
  };
};

/**
 * Find the newest create_signal call in an Antigravity transcript (JSON Lines, one step per
 * line) and the signal link in its result. A model step (PLANNER_RESPONSE) lists its tool calls,
 * and their results follow it in the same order. Older calls never count: a newer create_signal
 * rotates the link, so when its result is missing or failed there is no link. `truncated` says
 * that this file cut the result short, so a fuller transcript can still hold the link.
 * @param {string} transcript
 * @returns {{ link: SignalLink | null, truncated: boolean }}
 */
export const transcriptLink = (transcript) => {
  const none = { link: null, truncated: false };
  if (!transcript.includes("create_signal")) return none;
  /** @type {Array<Fields>} */
  const steps = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const step = fieldsOf(JSON.parse(line));
      if (step !== null) steps.push(step);
    } catch {
      // A line that is still being written, or a damaged one.
    }
  }
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step === undefined || step.get("type") !== "PLANNER_RESPONSE") continue;
    const calls = step.get("tool_calls");
    if (!Array.isArray(calls)) continue;
    const position = calls.findIndex((call) => createSignal.test(calledTool(call) ?? ""));
    if (position === -1) continue;
    /** @type {Array<Fields>} */
    const results = [];
    for (const later of steps.slice(index + 1)) {
      const type = later.get("type");
      if (isText(type) && nextTurn.has(type)) break;
      if (!(isText(type) && notResults.has(type))) results.push(later);
    }
    const result = results[position];
    if (result === undefined) return none;
    const link = resultLink(result.get("content"));
    const cut = result.get("truncated_fields");
    return { link, truncated: link === null && Array.isArray(cut) && cut.includes("content") };
  }
  return none;
};

/** The last `limit` bytes of a file, from its first whole line. @param {string} path @param {number} limit */
const tail = async (path, limit) => {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const content = buffer.toString("utf8");
    return start === 0 ? content : content.slice(content.indexOf("\n") + 1);
  } finally {
    await file.close();
  }
};
const transcriptLimit = 16 * 1024 * 1024;

/**
 * Antigravity's hook input names the conversation transcript (`transcriptPath`). agy 1.5.7
 * writes it as `brain/<conversationId>/.system_generated/logs/transcript.jsonl`. That file cuts
 * long step content short and lists the field in `truncated_fields`; `transcript_full.jsonl`
 * next to it keeps the content whole, so the hook reads it only then.
 * @param {Record<string, unknown>} input @returns {Promise<SignalLink | null>}
 */
const antigravityLink = async (input) => {
  const path = text(input.transcriptPath);
  if (path === null || !isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  const found = transcriptLink(await tail(path, transcriptLimit));
  if (found.link !== null || !found.truncated) return found.link;
  if (basename(path) !== "transcript.jsonl") return null;
  const full = await tail(join(dirname(path), "transcript_full.jsonl"), transcriptLimit);
  return transcriptLink(full).link;
};

/** The exact command that starts the Antigravity watcher. @param {string} script */
const startWatcher = (script) =>
  `run \`node "${script}" watch antigravity\` with run_command as a background task (WaitMsBeforeAsync 3000).`;

/**
 * Google Antigravity plugins. PostToolUse output never reaches the model and carries no tool
 * output, so mid-turn checks run on PreInvocation (before every model call) and inject an
 * ephemeral step. Stop continues with decision "continue". No hook input has create_signal's
 * result, so PreInvocation and Stop read it from the conversation transcript; the `save`
 * command stays as the fallback.
 * @type {Host}
 */
export const antigravity = {
  name: "antigravity",
  updateSteps:
    "run `git pull` in your clone of talkto-sh/talkto-plugin, then `agy plugin install <clone>/hooks/gemini` again, then restart Antigravity",
  idleNote: (script) =>
    `While you are idle, the TalkTo watcher starts a turn in this conversation when direct messages, @mentions of you or TalkTo notices wait; other channel messages wait for your next turn. Start it in every session that joins TalkTo, right after the hook confirms the link: ${startWatcher(script)} If the sandbox blocks node, run it again with BypassSandbox so the person can allow it. The person sees your reply in their window, but not the notice. It stops when Antigravity closes. If the person asks you to stop watching, stop its background task and do not start it again in this conversation. If Antigravity stopped it, for example after a resume, start it again.`,
  savedNote: (script) =>
    `Now start the TalkTo watcher, unless the person asked you to stop watching: ${startWatcher(script)}`,
  watcher: (env) => {
    const conversation = text(env.ANTIGRAVITY_CONVERSATION_ID);
    if (conversation === null || text(env.ANTIGRAVITY_LS_ADDRESS) === null) return null;
    // agy names itself in ANTIGRAVITY_AGENTAPI_EXE; Antigravity's sidecars get `agentapi` on PATH.
    const exe = text(env.ANTIGRAVITY_AGENTAPI_EXE);
    const file = exe ?? "agentapi";
    const prefix = exe === null ? [] : ["agentapi"];
    return {
      sessionId: conversation,
      deliver: (notice) =>
        new Promise((resolve) => {
          execFile(
            file,
            [...prefix, "send-message", conversation, notice],
            { env, timeout: 15_000, encoding: "utf8", maxBuffer: 64 * 1024 },
            (error, stdout) => {
              if (error !== null) return resolve(false);
              try {
                const reply = fieldsOf(JSON.parse(stdout));
                resolve(reply !== null && reply.has("response") && !reply.has("error"));
              } catch {
                resolve(false);
              }
            },
          );
        }),
    };
  },
  parse: (kind, input) => {
    const paths = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
    const toolName = text(fieldsOf(input.toolCall)?.get("name"));
    return event(kind, {
      sessionId: first(input, ["conversationId"]),
      cwd: first(input, ["cwd"]) ?? text(paths[0]),
      toolName,
      // agy 1.5.7 sends continuationActive; earlier docs named it continuation_active.
      stopActive: input.continuationActive === true || input.continuation_active === true,
      skip:
        kind === "stop" && input.error !== undefined && input.error !== null && input.error !== "",
    });
  },
  findLink: (kind, input) =>
    kind === "afterTool" || kind === "stop" ? antigravityLink(input) : Promise.resolve(null),
  render: (hook, reply) => {
    if (hook.kind === "stop")
      return reply.continueWith === undefined
        ? ""
        : JSON.stringify({ decision: "continue", reason: reply.continueWith });
    return reply.context === undefined
      ? ""
      : JSON.stringify({ injectSteps: [{ ephemeralMessage: reply.context }] });
  },
};

/** @type {Record<string, Host>} */
export const hosts = { claude, codex, cursor, copilot, gemini, antigravity };
