"""Loads the plugin folder as a package and fakes what TalkTo and Hermes answer."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
NAME = "talkto_hermes_plugin"


def load():
    """The plugin package, imported the way Hermes imports a plugin folder."""
    if NAME in sys.modules:
        return sys.modules[NAME]
    spec = importlib.util.spec_from_file_location(
        NAME, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[NAME] = module
    spec.loader.exec_module(module)
    return module


SERVER = "11111111-1111-4111-8111-111111111111"
ME = "22222222-2222-4222-8222-222222222222"
PEER = "33333333-3333-4333-8333-333333333333"
GENERAL = "44444444-4444-4444-8444-444444444444"
DIRECT = "55555555-5555-4555-8555-555555555555"

_sequence = 0


def message(**fields: Any) -> dict[str, Any]:
    global _sequence
    _sequence += 1
    return {
        "id": f"m-{_sequence}",
        "sequence": _sequence,
        "conversationId": GENERAL,
        "senderId": PEER,
        "body": f"hello {_sequence}",
        "createdAt": "2026-11-11T10:00:00.000Z",
        **fields,
    }


def envelope(messages: list[dict[str, Any]], next_cursor: Any = None, checkpoint: str = "") -> dict[str, Any]:
    return {
        "data": {
            "messages": messages,
            "checkpoint": checkpoint or f"cp-{_sequence}",
            "nextCursor": next_cursor,
        },
        "included": {
            "participants": [{"id": PEER, "name": "planner", "agentType": "codex"}],
            "conversations": [
                {"id": GENERAL, "kind": "channel", "name": "general"},
                {"id": DIRECT, "kind": "direct", "participantIds": [ME, PEER]},
            ],
        },
        "meta": {},
    }


def context(general: str = GENERAL) -> dict[str, Any]:
    """A get_context reply naming the server's General channel."""
    return {
        "data": {"server": {"id": SERVER, "name": "Team", "generalConversationId": general}},
        "included": {"participants": [], "conversations": []},
        "meta": {},
    }


def refusal(code: str, text: str = "no") -> dict[str, Any]:
    return {"error": {"code": code, "message": text}, "meta": {}}


class Clock:
    """Time that moves only when a test says so, with the timers that come due."""

    def __init__(self) -> None:
        self.time = 0.0
        self.timers: list[tuple[float, Callable[[], None]]] = []

    def after(self, ms: float, run: Callable[[], None]) -> None:
        self.timers.append((self.time + ms, run))

    def advance(self, ms: float) -> None:
        self.time += ms
        due = [timer for timer in self.timers if timer[0] <= self.time]
        self.timers = [timer for timer in self.timers if timer[0] > self.time]
        for _, run in due:
            run()


class FakeHost:
    """An inbox host whose TalkTo answers come from a list and whose effects are recorded.
    get_context is answered apart, from ``context`` (a reply or an exception), and recorded in
    ``contexts``."""

    connection_hint = "Check the connection."

    def __init__(self) -> None:
        self.plugin = load()
        self.clock = Clock()
        self.answers: list[Any] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.contexts: list[dict[str, Any]] = []
        self.context: Any = context()
        self.submitted: list[str] = []
        self.submit_answer = True
        self.stored: Any = None

    def call(self, tool: str, args: Any):
        inbox = self.plugin.inbox
        if tool == "get_context":
            self.contexts.append(dict(args))
            answer = self.context
        else:
            self.calls.append((tool, dict(args)))
            answer = self.answers.pop(0) if self.answers else envelope([])
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, inbox.Answer):
            return answer
        return inbox.Answer(answer)

    def submit(self, text: str) -> bool:
        self.submitted.append(text)
        return self.submit_answer

    def load(self) -> Any:
        return copy.deepcopy(self.stored)

    def save(self, state: Any) -> None:
        self.stored = json.loads(json.dumps(state))

    def now(self) -> float:
        return self.clock.time

    def after(self, ms: float, run: Callable[[], None]) -> None:
        self.clock.after(ms, run)
