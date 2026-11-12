// Each adapter reads its host's documented hook input and writes its host's documented output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hosts } from "../src/hosts.mjs";

const say = { context: "TalkTo: note" };
const go = { continueWith: "TalkTo: 2 new messages." };
const kinds = /** @type {const} */ (["sessionStart", "promptSubmit", "afterTool", "stop"]);
const render = (host, kind, reply, input = {}) => host.render(host.parse(kind, input, {}), reply);

test("every adapter stays silent when there is nothing to say", () => {
  for (const host of Object.values(hosts))
    for (const kind of kinds) assert.equal(render(host, kind, {}), "", `${host.name} ${kind}`);
});

test("Claude format (Claude Code, Codex, Droid, Grok Build, Devin)", () => {
  for (const host of [hosts.claude, hosts.codex]) {
    assert.deepEqual(JSON.parse(render(host, "stop", go)), {
      decision: "block",
      reason: go.continueWith,
    });
    const names = {
      sessionStart: "SessionStart",
      promptSubmit: "UserPromptSubmit",
      afterTool: "PostToolUse",
    };
    for (const [kind, hookEventName] of Object.entries(names))
      assert.deepEqual(JSON.parse(render(host, kind, say)), {
        hookSpecificOutput: { hookEventName, additionalContext: say.context },
      });
  }
  const snake = hosts.claude.parse(
    "afterTool",
    {
      session_id: "a",
      cwd: "/w",
      tool_name: "mcp__talkto__create_signal",
      tool_response: { x: 1 },
    },
    {},
  );
  assert.deepEqual(
    [snake.sessionId, snake.cwd, snake.toolName, snake.toolResponse],
    ["a", "/w", "mcp__talkto__create_signal", { x: 1 }],
  );
  // Grok Build sends camelCase, and a Stop whose reason says the session is closing.
  const camel = hosts.claude.parse(
    "stop",
    { sessionId: "b", workspaceRoot: "/g", stopHookActive: true, reason: "end_turn" },
    {},
  );
  assert.deepEqual(
    [camel.sessionId, camel.cwd, camel.stopActive, camel.skip],
    ["b", "/g", true, false],
  );
  for (const reason of ["shutdown", "channel_closed"])
    assert.equal(hosts.claude.parse("stop", { reason }, {}).skip, true);
  // Devin gives the project folder in its environment.
  assert.equal(hosts.claude.parse("stop", {}, { DEVIN_PROJECT_DIR: "/d" }).cwd, "/d");
});

test("Cursor: followup_message and additional_context; only completed turns continue", () => {
  const host = hosts.cursor;
  assert.deepEqual(JSON.parse(render(host, "stop", go, { status: "completed" })), {
    followup_message: go.continueWith,
  });
  for (const kind of ["sessionStart", "afterTool"])
    assert.deepEqual(JSON.parse(render(host, kind, say)), { additional_context: say.context });
  const parsed = host.parse(
    "afterTool",
    {
      conversation_id: "c",
      workspace_roots: ["/r"],
      tool_name: "MCP:create_signal",
      tool_output: "{}",
    },
    {},
  );
  assert.deepEqual(
    [parsed.sessionId, parsed.cwd, parsed.toolName, parsed.toolResponse],
    ["c", "/r", "MCP:create_signal", "{}"],
  );
  assert.equal(host.parse("stop", { status: "aborted" }, {}).skip, true);
  assert.equal(host.parse("stop", { status: "error" }, {}).skip, true);
  assert.equal(host.parse("stop", { status: "completed", loop_count: 1 }, {}).stopActive, true);
});

test("GitHub Copilot (CLI and VS Code): decision/reason at agentStop, top-level additionalContext", () => {
  const host = hosts.copilot;
  assert.deepEqual(JSON.parse(render(host, "stop", go)), {
    decision: "block",
    reason: go.continueWith,
  });
  for (const kind of ["sessionStart", "afterTool"])
    assert.deepEqual(JSON.parse(render(host, kind, say)), { additionalContext: say.context });
  const parsed = host.parse(
    "afterTool",
    {
      sessionId: "p",
      cwd: "/c",
      toolName: "talkto-create_signal",
      toolResult: { textResultForLlm: "{}" },
    },
    {},
  );
  assert.deepEqual(
    [parsed.sessionId, parsed.toolName, parsed.toolResponse],
    ["p", "talkto-create_signal", { textResultForLlm: "{}" }],
  );
  assert.equal(host.parse("stop", { stopReason: "end_turn" }, {}).skip, false);
  assert.equal(host.parse("stop", { stopReason: "user_cancelled" }, {}).skip, true);
});

test("Gemini CLI: AfterAgent denies with a reason; context in hookSpecificOutput", () => {
  const host = hosts.gemini;
  assert.deepEqual(JSON.parse(render(host, "stop", go)), {
    decision: "deny",
    reason: go.continueWith,
  });
  for (const kind of ["sessionStart", "promptSubmit", "afterTool"])
    assert.deepEqual(JSON.parse(render(host, kind, say)), {
      hookSpecificOutput: { additionalContext: say.context },
    });
  const parsed = host.parse(
    "afterTool",
    { tool_name: "mcp_talkto_create_signal", tool_response: { llmContent: "{}" } },
    { GEMINI_SESSION_ID: "g", GEMINI_CWD: "/gc" },
  );
  assert.deepEqual(
    [parsed.sessionId, parsed.cwd, parsed.toolName],
    ["g", "/gc", "mcp_talkto_create_signal"],
  );
  assert.equal(host.parse("stop", { stop_hook_active: true }, {}).stopActive, true);
});

test("Antigravity: Stop continues; mid-turn notices are ephemeral steps before the next model call", () => {
  const host = hosts.antigravity;
  assert.deepEqual(JSON.parse(render(host, "stop", go)), {
    decision: "continue",
    reason: go.continueWith,
  });
  for (const kind of ["sessionStart", "afterTool"])
    assert.deepEqual(JSON.parse(render(host, kind, say)), {
      injectSteps: [{ ephemeralMessage: say.context }],
    });
  const parsed = host.parse(
    "afterTool",
    { conversationId: "ag", workspacePaths: ["/a"], toolCall: { name: "run_command" } },
    {},
  );
  assert.deepEqual(
    [parsed.sessionId, parsed.cwd, parsed.toolName, parsed.toolResponse],
    ["ag", "/a", "run_command", null],
  );
  // agy 1.5.7 sends camelCase continuationActive (seen live); keep the snake_case alias.
  assert.equal(host.parse("stop", { continuationActive: true }, {}).stopActive, true);
  assert.equal(host.parse("stop", { continuation_active: true }, {}).stopActive, true);
  assert.equal(host.parse("stop", { continuationActive: false }, {}).stopActive, false);
  assert.equal(host.parse("stop", { error: "model failed" }, {}).skip, true);
});
