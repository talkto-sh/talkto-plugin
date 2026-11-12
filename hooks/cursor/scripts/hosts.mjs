// @ts-check
// Thin per-host adapters: parse a host's hook input into a HookEvent, and render a Reply as that
// host's documented output. Sources are listed in the README, per host.

import { fieldsOf, isNumber, isText } from "./core.mjs";

/** @typedef {import("./core.mjs").HookEvent} HookEvent */
/** @typedef {import("./core.mjs").Reply} Reply */
/** @typedef {HookEvent["kind"]} Kind */

/**
 * @typedef {object} Host
 * @property {string} name
 * @property {(kind: Kind, input: Record<string, unknown>, env: NodeJS.ProcessEnv) => HookEvent} parse
 * @property {(event: HookEvent, reply: Reply) => string} render JSON for stdout, or "" for nothing.
 */

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
};

/** Codex uses Claude Code's format, with no continuation cap of its own; core caps it. */
export const codex = { ...claude, name: "codex" };

/**
 * Cursor's native hooks (`.cursor-plugin`). Stop continues with `followup_message`, submitted as
 * the next user message; only a completed turn continues. postToolUse and sessionStart take
 * `additional_context`. Cursor has no prompt-time context, so promptSubmit is not installed.
 * @type {Host}
 */
export const cursor = {
  name: "cursor",
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
 * Google Antigravity plugins. PostToolUse output never reaches the model and carries no tool
 * output, so mid-turn checks run on PreInvocation (before every model call) and inject an
 * ephemeral step. Stop continues with decision "continue". The agent saves its link with the
 * `save` command, because no hook sees create_signal's result.
 * @type {Host}
 */
export const antigravity = {
  name: "antigravity",
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
