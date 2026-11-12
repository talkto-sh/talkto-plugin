"""The Hermes binding against a fake plugin context: registration, TalkTo
calls through ctx.call_mcp, delivery with inject_message, urgent messages in
transform_tool_result, and state that never holds a token."""

from __future__ import annotations

import json
import logging
import unittest
from pathlib import Path
from typing import Any

from support import DIRECT, GENERAL, ME, SERVER, Clock, envelope, load, message, refusal

plugin = load()
binding = plugin.plugin
logging.getLogger("talkto-plugin").setLevel(logging.ERROR)
SESSION, KEY = "20261111_120000_abcd", "agent:main:local:dm:ses_1"


def hermes_ok(reply: dict[str, Any]) -> dict[str, Any]:
    """What ctx.call_mcp returns for a TalkTo answer: its text block as `result`."""
    return {"ok": True, "result": json.dumps(reply)}


def hermes_error(reply: dict[str, Any]) -> dict[str, Any]:
    """What ctx.call_mcp returns for an isError answer: the text block as `error`."""
    return {"ok": False, "error": json.dumps(reply)}


class State:
    def __init__(self) -> None:
        self.values: dict[str, Any] = {}

    def get(self, key: str, default: Any = None) -> Any:
        return json.loads(json.dumps(self.values.get(key, default)))

    def set(self, key: str, value: Any) -> None:
        self.values[key] = json.loads(json.dumps(value))


class FakeContext:
    def __init__(self) -> None:
        self.tools: dict[str, dict[str, Any]] = {}
        self.hooks: dict[str, Any] = {}
        self.commands: dict[str, Any] = {}
        self.answers: list[Any] = []
        self.calls: list[tuple[str, str, dict[str, Any], float]] = []
        self.injected: list[tuple[str, str, str]] = []
        self.inject_answer = True
        self.config: dict[str, Any] = {}
        self.state = State()

    def register_tool(self, name, toolset, schema, handler, **_: Any) -> None:
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}

    def register_hook(self, name, callback, **_: Any) -> None:
        self.hooks[name] = callback

    def register_command(self, name, handler, description="", **_: Any) -> None:
        self.commands[name] = handler

    def call_mcp(self, server, tool, arguments=None, timeout=30):
        self.calls.append((server, tool, dict(arguments or {}), timeout))
        answer = self.answers.pop(0) if self.answers else hermes_ok(envelope([]))
        if isinstance(answer, Exception):
            raise answer
        return answer

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        self.injected.append((content, role, session_key))
        return self.inject_answer

    def get_config(self, key, default=None):
        return self.config.get(key, default)


def started(ctx: FakeContext | None = None):
    ctx = ctx or FakeContext()
    clock = Clock()
    instance = binding.TalkToPlugin(
        ctx, binding.Deps(now=lambda: clock.time, after=clock.after, session_key=lambda: KEY)
    )
    instance.register()
    return ctx, clock, instance


def follow(ctx: FakeContext, clock: Clock) -> str:
    ctx.answers.append(hermes_ok(envelope([])))
    answer = ctx.tools["talkto_follow"]["handler"](
        {"serverId": SERVER, "participantId": ME, "channelIds": [GENERAL]},
        task_id=SESSION,
        session_id=SESSION,
    )
    clock.time = 100_000
    return json.loads(answer)["message"]


class PluginTest(unittest.TestCase):
    def test_registers_tools_hooks_and_command_named_in_the_manifest(self) -> None:
        ctx, _, _ = started()
        text = (Path(load().plugin.__file__).parent / "plugin.yaml").read_text(encoding="utf-8")
        for name in ctx.tools:
            self.assertIn(f"  - {name}\n", text)
        for name in ctx.hooks:
            self.assertIn(f"  - {name}\n", text)
        self.assertEqual(set(ctx.tools), {"talkto_follow", "talkto_unfollow"})
        self.assertIn("talkto-inbox", ctx.commands)
        self.assertIn("this Hermes session", ctx.tools["talkto_follow"]["schema"]["description"])
        self.assertEqual(ctx.tools["talkto_follow"]["schema"]["parameters"]["required"], ["serverId", "participantId"])

    def test_the_toolset_is_not_named_after_the_talkto_mcp_server(self) -> None:
        # Hermes aliases each MCP server's name to its toolset (mcp-talkto), so a plugin toolset
        # named "talkto" hides either the plugin's tools or TalkTo's MCP tools.
        ctx, _, _ = started()
        self.assertEqual({tool["toolset"] for tool in ctx.tools.values()}, {"talkto-plugin"})
        self.assertNotEqual(binding.TOOLSET, binding.DEFAULT_SERVER)

    def test_follow_calls_talkto_through_hermes_mcp_with_the_agents_own_participant(self) -> None:
        ctx, clock, _ = started()
        self.assertTrue(follow(ctx, clock).startswith("Following participant"))
        server, tool, args, timeout = ctx.calls[0]
        self.assertEqual((server, tool), ("talkto", "get_updates"))
        self.assertEqual(args["participantId"], ME)
        self.assertGreater(timeout, 20, "longer than TalkTo's 20 second wait")

    def test_the_mcp_server_name_comes_from_the_settings(self) -> None:
        ctx = FakeContext()
        ctx.config["mcp_server"] = "talkto-staging"
        ctx, clock, _ = started(ctx)
        follow(ctx, clock)
        self.assertEqual(ctx.calls[0][0], "talkto-staging")

    def test_a_missing_grant_tells_the_agent_what_to_set(self) -> None:
        ctx, _, _ = started()
        ctx.answers.append(PermissionError("not allowed: plugins.entries.talkto-plugin.mcp_allowlist"))
        answer = json.loads(
            ctx.tools["talkto_follow"]["handler"]({"serverId": SERVER, "participantId": ME}, session_id=SESSION)
        )["message"]
        self.assertIn("Could not reach TalkTo", answer)
        self.assertIn("mcp_allowlist", answer)

    def test_a_talkto_refusal_reaches_the_agent_with_its_code(self) -> None:
        ctx, _, _ = started()
        ctx.answers.append(hermes_error(refusal("participant_not_found", "no such participant")))
        answer = json.loads(
            ctx.tools["talkto_follow"]["handler"]({"serverId": SERVER, "participantId": ME}, session_id=SESSION)
        )["message"]
        self.assertEqual(answer, "TalkTo refused the follow: participant_not_found: no such participant")

    def test_queued_messages_start_a_turn_in_the_same_session_once_idle(self) -> None:
        ctx, clock, _ = started()
        ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t1", user_message="work", platform="cli")
        follow(ctx, clock)
        ctx.answers.append(hermes_ok(envelope([message(body="review please")])))
        clock.advance(0)
        self.assertEqual(ctx.injected, [], "nothing interrupts the running turn")
        ctx.hooks["on_session_end"](session_id=SESSION, turn_id="t1", completed=True)
        clock.advance(binding.WAIT_SECONDS)
        clock.advance(2000)
        self.assertEqual(len(ctx.injected), 1)
        content, role, key = ctx.injected[0]
        self.assertEqual((role, key), ("user", KEY))
        self.assertIn("review please", content)
        self.assertIsNone(ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t2", user_message=content))
        self.assertIn("0 queued", ctx.commands["talkto-inbox"]("", session_key=KEY))

    def test_an_urgent_direct_message_is_added_to_the_next_tool_result(self) -> None:
        ctx, clock, _ = started()
        ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t1", user_message="deploy")
        follow(ctx, clock)
        ctx.answers.append(
            hermes_ok(envelope([message(conversationId=DIRECT, priority="urgent", body="stop the deploy")]))
        )
        clock.advance(0)
        self.assertIsNone(
            ctx.hooks["transform_tool_result"](
                tool_name="terminal", result='{"output": "ok"}', session_id="subagent", turn_id="t9"
            ),
            "another agent's tool call never gets it",
        )
        changed = ctx.hooks["transform_tool_result"](
            tool_name="terminal", result='{"output": "ok"}', session_id=SESSION, turn_id="t1"
        )
        assert changed is not None
        self.assertTrue(changed.startswith('{"output": "ok"}\n\n'))
        self.assertIn("stop the deploy", changed)
        ctx.hooks["pre_api_request"](
            session_id=SESSION, turn_id="t1", request_messages=[{"role": "tool", "content": changed}]
        )
        ctx.hooks["on_session_end"](session_id=SESSION, turn_id="t1", completed=True)
        clock.advance(2000)
        self.assertEqual(ctx.injected, [], "read in the turn: not delivered again")

    def test_without_gateway_injection_the_queue_goes_with_the_next_prompt(self) -> None:
        ctx, clock, _ = started()
        ctx.inject_answer = False
        follow(ctx, clock)
        ctx.answers.append(hermes_ok(envelope([message(body="ping")])))
        clock.advance(0)
        self.assertEqual(len(ctx.injected), 1)
        extra = ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t1", user_message="hello")
        self.assertIn("ping", extra["context"])

    def test_a_refused_injection_names_the_session_and_does_not_guess_the_cause(self) -> None:
        ctx, clock, _ = started()
        ctx.inject_answer = False
        follow(ctx, clock)
        ctx.answers.append(hermes_ok(envelope([message(body="ping")])))
        with self.assertLogs("talkto-plugin", level="WARNING") as logs:
            clock.advance(0)
        text = "\n".join(logs.output)
        self.assertIn(KEY, text)
        self.assertIn("not a live local session", text)
        self.assertNotIn("Set plugins.entries", text, "the setting may already be on")

    def test_an_ended_session_is_never_polled_or_given_a_turn(self) -> None:
        ctx, clock, _ = started()
        ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t1", user_message="work")
        follow(ctx, clock)
        ctx.hooks["on_session_end"](session_id=SESSION, turn_id="t1", completed=True)
        # A one-shot run ends its session; Hermes's gateway, and the plugin, stay up.
        ctx.hooks["on_session_finalize"](session_id=SESSION, platform="cli", reason="cli_close")
        calls = len(ctx.calls)
        ctx.answers.append(hermes_ok(envelope([message(body="too late")])))
        clock.advance(binding.WAIT_SECONDS * 1000)
        clock.advance(60_000)
        self.assertEqual(len(ctx.calls), calls, "no more polls for the ended session")
        self.assertEqual(ctx.injected, [], "no turn is started in the ended session")
        (saved,) = ctx.state.values.values()
        self.assertEqual(len(saved["follows"]), 1, "the follow stays saved")

        # The same session resumed: delivery restarts from the saved checkpoint.
        ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t2", user_message="back")
        clock.advance(0)
        self.assertGreater(len(ctx.calls), calls)
        self.assertEqual(ctx.calls[calls][2]["checkpoint"], saved["follows"][0]["checkpoint"])

    def test_a_deleted_session_forgets_its_follows(self) -> None:
        ctx, clock, _ = started()
        follow(ctx, clock)
        ctx.hooks["on_session_delete"](session_id=SESSION, reason="delete", profile="default")
        self.assertEqual(list(ctx.state.values.values()), [None])
        self.assertIn("follows no participant", ctx.commands["talkto-inbox"]("", session_key=KEY))

    def test_an_urgent_message_reaches_a_turn_whose_start_the_plugin_missed(self) -> None:
        ctx, clock, _ = started()
        follow(ctx, clock)  # no pre_llm_call: the plugin loaded while the turn ran
        # The follow call's own result tells the plugin which turn runs.
        ctx.hooks["transform_tool_result"](
            tool_name="talkto_follow", result="{}", session_id=SESSION, turn_id="t7"
        )
        ctx.answers.append(
            hermes_ok(envelope([message(conversationId=DIRECT, priority="urgent", body="stop now")]))
        )
        clock.advance(0)
        changed = ctx.hooks["transform_tool_result"](
            tool_name="terminal", result="ok", session_id=SESSION, turn_id="t7"
        )
        assert changed is not None
        self.assertIn("stop now", changed)
        self.assertEqual(ctx.injected, [], "not also started as a turn of its own")

    def test_a_late_tool_result_does_not_restart_an_ended_turn(self) -> None:
        ctx, clock, _ = started()
        ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t1", user_message="work")
        follow(ctx, clock)
        ctx.hooks["on_session_end"](session_id=SESSION, turn_id="t1", completed=True)
        ctx.hooks["transform_tool_result"](tool_name="terminal", result="ok", session_id=SESSION, turn_id="t1")
        ctx.answers.append(hermes_ok(envelope([message(body="after the turn")])))
        clock.advance(binding.WAIT_SECONDS * 1000)
        clock.advance(2000)
        self.assertEqual(len(ctx.injected), 1, "the session is idle, so the notice starts a turn")

    def test_subagent_turns_are_ignored(self) -> None:
        ctx, clock, _ = started()
        follow(ctx, clock)
        self.assertIsNone(
            ctx.hooks["pre_llm_call"](session_id="child", parent_session_id=SESSION, turn_id="c1", user_message="x")
        )
        ctx.hooks["on_session_end"](session_id="child", turn_id="c1")

    def test_state_is_saved_per_session_and_never_holds_a_token(self) -> None:
        ctx, clock, _ = started()
        follow(ctx, clock)
        ctx.answers.append(hermes_ok(envelope([message(body="kept")])))
        ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t1", user_message="x")
        clock.advance(0)
        saved = json.dumps(ctx.state.values)
        self.assertIn("kept", saved)
        for word in ("token", "Bearer", "authorization", "refresh"):
            self.assertNotIn(word.lower(), saved.lower())
        self.assertTrue(all(key.startswith("session.") for key in ctx.state.values))

        # A restart: a new plugin instance finds the session when its next turn starts.
        _, clock2, _ = started(ctx)
        ctx.hooks["pre_llm_call"](session_id=SESSION, turn_id="t2", user_message="x")
        ctx.hooks["on_session_end"](session_id=SESSION, turn_id="t2")
        clock2.advance(2000)
        self.assertIn("kept", ctx.injected[-1][0])

    def test_unfollow_clears_the_saved_session(self) -> None:
        ctx, clock, _ = started()
        follow(ctx, clock)
        answer = json.loads(ctx.tools["talkto_unfollow"]["handler"]({"serverId": SERVER}, session_id=SESSION))
        self.assertIn("Stopped following", answer["message"])
        self.assertEqual(list(ctx.state.values.values()), [None])


class SessionKeyTest(unittest.TestCase):
    def test_the_key_is_what_hermes_bound_to_this_call_never_the_process_environment(self) -> None:
        import os
        import sys
        import types

        gateway = types.ModuleType("gateway")
        context = types.ModuleType("gateway.session_context")
        context.bound_session_key = lambda: ""  # type: ignore[attr-defined]
        context.get_session_env = lambda name, default="": os.environ.get(name, default)  # type: ignore[attr-defined]
        saved = {name: sys.modules.get(name) for name in ("gateway", "gateway.session_context")}
        sys.modules.update({"gateway": gateway, "gateway.session_context": context})
        os.environ["HERMES_SESSION_KEY"] = "agent:main:local:dm:an-ended-session"
        try:
            self.assertEqual(binding._hermes_session_key(), "")
            context.bound_session_key = lambda: KEY  # type: ignore[attr-defined]
            self.assertEqual(binding._hermes_session_key(), KEY)
            del context.bound_session_key  # an older Hermes
            self.assertEqual(binding._hermes_session_key(), "agent:main:local:dm:an-ended-session")
        finally:
            del os.environ["HERMES_SESSION_KEY"]
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


class AnswerTest(unittest.TestCase):
    def test_reads_every_shape_ctx_call_mcp_returns(self) -> None:
        reply = envelope([])
        self.assertEqual(binding._answer({"ok": True, "result": json.dumps(reply)}).envelope, reply)
        self.assertEqual(binding._answer({"ok": True, "result": reply}).envelope, reply)
        self.assertEqual(
            binding._answer({"ok": True, "result": "summary", "structuredContent": reply}).envelope, reply
        )
        cut = binding._answer({"ok": True, "result": '{"data": ', "truncated": True})
        self.assertTrue(cut.truncated)
        self.assertIsNone(cut.envelope)
        self.assertEqual(binding._answer(hermes_error(refusal("x"))).envelope, refusal("x"))
        with self.assertRaises(plugin.inbox.TransportError):
            binding._answer({"ok": False, "error": "MCP server 'talkto' is not connected"})


if __name__ == "__main__":
    unittest.main()
