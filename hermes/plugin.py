"""talkto-plugin for Hermes Agent: TalkTo messages delivered between turns,
urgent direct messages into the running turn.

- TalkTo is one of the person's own Hermes MCP servers (``hermes mcp add
  talkto --url https://talkto.sh/mcp --auth oauth``). Hermes runs the browser
  sign-in, stores the token and renews it. The plugin calls TalkTo only through
  ``ctx.call_mcp``, so it never sees a token and adds no credential.
- ``talkto_follow`` starts delivery for the participant the agent names.
  Nothing is inferred from the MCP connection, which identifies a person, not an
  agent.
- Queued messages arrive as one turn of their own once the session is idle
  (``ctx.inject_message``). Urgent ones are added to the result of the tool call
  that finishes next in the running turn (``transform_tool_result``).
- Follows, checkpoints and queued notices are kept per session in the plugin's
  own state (``ctx.state``). They never hold a token.
- Hermes's gateway, where plugins run, outlives each session: a one-shot
  ``hermes chat -q`` session ends after its turn while the gateway stays up.
  When Hermes ends a session (``on_session_finalize``) the plugin stops
  polling and delivering for it, so it never starts turns in an ended session.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from .inbox import (
    WAIT_SECONDS,
    Answer,
    Inbox,
    Settings,
    TransportError,
    WaitPolicy,
    read_follow_input,
)
from .tools import (
    FOLLOW_PARAMETERS,
    UNFOLLOW_DESCRIPTION,
    UNFOLLOW_PARAMETERS,
    follow_description,
)

PLUGIN_ID = "talkto-plugin"
#: The plugin's own toolset. Never "talkto": Hermes registers each MCP server's name as an alias
#: of that server's toolset (``mcp-talkto``), so a plugin toolset named after the server hides
#: one of the two sets of tools.
TOOLSET = "talkto-plugin"
COMMAND = "talkto-inbox"
#: The Hermes MCP server name TalkTo is configured under, unless the settings name another.
DEFAULT_SERVER = "talkto"
#: Seconds one TalkTo call may take: the longest server wait plus room for the network.
CALL_TIMEOUT = WAIT_SECONDS + 15
#: Request messages searched for an urgent notice, newest first.
_RECENT_MESSAGES = 12

logger = logging.getLogger("talkto-plugin")


@dataclass(frozen=True)
class Deps:
    """Everything from outside Hermes's plugin context; tests replace it."""

    now: Callable[[], float]
    #: Runs a callable once after some milliseconds.
    after: Callable[[float, Callable[[], None]], None]
    #: The routing key of the session the current hook or tool runs for, "" when unknown.
    session_key: Callable[[], str]


def _hermes_session_key() -> str:
    # bound_session_key reads only what Hermes bound in this context, never os.environ, so a
    # thread that inherited no session never borrows another session's key. Older Hermes
    # versions have only get_session_env.
    try:
        from gateway.session_context import bound_session_key
    except ImportError:
        pass
    else:
        return bound_session_key()
    try:
        from gateway.session_context import get_session_env
    except ImportError:
        return ""
    return get_session_env("HERMES_SESSION_KEY", "")


def default_deps() -> Deps:
    # Timers run in a copy of the context register() ran in: the plugin's own
    # profile, and no session binding, so a timer never borrows a session.
    base = contextvars.copy_context()

    def after(ms: float, run: Callable[[], None]) -> None:
        def guarded() -> None:
            try:
                base.copy().run(run)
            except Exception:
                logger.warning("talkto-plugin: a background step failed", exc_info=True)

        timer = threading.Timer(max(0.0, ms) / 1000, guarded)
        timer.daemon = True
        timer.start()

    return Deps(now=lambda: time.monotonic() * 1000, after=after, session_key=_hermes_session_key)


_WAITS: dict[str, WaitPolicy] = {"auto": "auto", "always": "always", "never": "never"}


def _text_of(content: object) -> str:
    """The text of a message's content, however Hermes shaped it."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(part.get("text", "")) if isinstance(part, Mapping) else str(part)
            for part in content
        )
    return ""


def _recent_text(messages: object) -> str:
    if not isinstance(messages, list):
        return ""
    recent = messages[-_RECENT_MESSAGES:]
    return "\n".join(
        _text_of(item.get("content")) if isinstance(item, Mapping) else "" for item in recent
    )


def _answer(raw: Mapping[str, Any]) -> Answer:
    """``ctx.call_mcp``'s envelope as TalkTo's own reply, or TransportError when the call failed."""
    truncated = raw.get("truncated") is True
    if raw.get("ok") is True:
        for candidate in (raw.get("structuredContent"), raw.get("result")):
            if isinstance(candidate, Mapping):
                return Answer(candidate, truncated)
            if isinstance(candidate, str):
                try:
                    parsed = json.loads(candidate)
                except ValueError:
                    continue
                if isinstance(parsed, Mapping):
                    return Answer(parsed, truncated)
        return Answer(None, truncated)
    error = raw.get("error")
    # A TalkTo refusal comes back as TalkTo's JSON reply; anything else means the call failed.
    if isinstance(error, str):
        try:
            parsed = json.loads(error)
        except ValueError:
            parsed = None
        if isinstance(parsed, Mapping) and isinstance(parsed.get("error"), Mapping):
            return Answer(parsed, truncated)
    raise TransportError(str(error) if error is not None else "the MCP call failed")


class TalkToPlugin:
    def __init__(self, ctx: Any, deps: Optional[Deps] = None) -> None:
        self._ctx = ctx
        self._deps = deps or default_deps()
        self._lock = threading.Lock()
        #: Inboxes by Hermes session key (the routing key inject_message takes).
        self._inboxes: dict[str, Inbox] = {}
        #: Session IDs (what hooks report) to session keys.
        self._keys: dict[str, str] = {}
        #: The running top-level turn of each session ID.
        self._turns: dict[str, str] = {}
        #: The last turn that ended in each session ID; a late tool result never restarts it.
        self._ended: dict[str, str] = {}
        self._turn_count = 0
        #: Session keys whose refused injection was already logged.
        self._warned_injection: set[str] = set()

    # -- registration ----------------------------------------------------------

    def register(self) -> None:
        ctx = self._ctx
        ctx.register_tool(
            name="talkto_follow",
            toolset=TOOLSET,
            schema={
                "name": "talkto_follow",
                "description": follow_description("this Hermes session"),
                "parameters": FOLLOW_PARAMETERS,
            },
            handler=self.follow_tool,
        )
        ctx.register_tool(
            name="talkto_unfollow",
            toolset=TOOLSET,
            schema={
                "name": "talkto_unfollow",
                "description": UNFOLLOW_DESCRIPTION,
                "parameters": UNFOLLOW_PARAMETERS,
            },
            handler=self.unfollow_tool,
        )
        ctx.register_command(
            COMMAND,
            self.inbox_command,
            description="Show which TalkTo participants this session follows and what is queued",
        )
        ctx.register_hook("pre_llm_call", self.on_pre_llm_call)
        ctx.register_hook("pre_api_request", self.on_pre_api_request)
        ctx.register_hook("transform_tool_result", self.on_transform_tool_result)
        ctx.register_hook("on_session_end", self.on_session_end)
        ctx.register_hook("on_session_open", self.on_session_open)
        ctx.register_hook("on_session_finalize", self.on_session_finalize)
        ctx.register_hook("on_session_delete", self.on_session_delete)
        ctx.register_hook("post_compaction", self.on_post_compaction)

    # -- settings ----------------------------------------------------------------

    def _setting(self, key: str, default: Any) -> Any:
        try:
            return self._ctx.get_config(key, default=default)
        except Exception:
            return default

    def _server(self) -> str:
        server = self._setting("mcp_server", DEFAULT_SERVER)
        return server if isinstance(server, str) and server else DEFAULT_SERVER

    def _settings(self) -> Settings:
        seconds = self._setting("poll_seconds", 15)
        if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
            seconds = 15
        return Settings(
            delivery="next-prompt"
            if self._setting("delivery", "idle") == "next-prompt"
            else "idle",
            urgent="queue" if self._setting("urgent", "inject") == "queue" else "inject",
            poll_millis=int(min(300, max(5, seconds)) * 1000),
            wait=_WAITS.get(str(self._setting("wait", "auto")), "auto"),
        )

    def _hint(self) -> str:
        server = self._server()
        return (
            f"Check that Hermes is signed in to TalkTo (hermes mcp login {server}) and that "
            f"plugins.entries.{PLUGIN_ID}.mcp_allowlist in config.yaml lists {server}."
        )

    # -- sessions ----------------------------------------------------------------

    def _key_for(self, session_id: str) -> str:
        key = self._deps.session_key()
        with self._lock:
            if key and session_id:
                self._keys[session_id] = key
            return key or self._keys.get(session_id) or session_id

    def _state_key(self, key: str) -> str:
        return "session." + hashlib.sha256(key.encode("utf-8")).hexdigest()[:40]

    def _host(self, key: str) -> "_HermesHost":
        return _HermesHost(self, key)

    def _inbox(self, key: str, create: bool) -> Optional[Inbox]:
        """The session's inbox, restored from its saved state; None when nothing is followed and not ``create``."""
        with self._lock:
            found = self._inboxes.get(key)
        if found is not None:
            return found
        inbox = Inbox(self._host(key), self._settings())
        inbox.restore()
        if not create and inbox.follows() == 0:
            return None
        with self._lock:
            return self._inboxes.setdefault(key, inbox)

    def _known(self, session_id: str) -> Optional[Inbox]:
        """The inbox of a session that follows someone, by the session ID hooks report."""
        with self._lock:
            key = self._keys.get(session_id)
            return None if key is None else self._inboxes.get(key)

    def _close(self, session_id: str, forget: bool) -> None:
        """Hermes ended the session: its inbox stops; ``forget`` also deletes what is saved."""
        if not session_id:
            return
        with self._lock:
            key = self._keys.pop(session_id, None)
            self._turns.pop(session_id, None)
            self._ended.pop(session_id, None)
            inbox = self._inboxes.pop(key, None) if key is not None else None
            if key is not None:
                # Compaction gives a session new IDs; none of them may find the closed inbox.
                for other in [sid for sid, value in self._keys.items() if value == key]:
                    del self._keys[other]
                    self._turns.pop(other, None)
                    self._ended.pop(other, None)
        if inbox is not None:
            inbox.close()
        if forget and key is not None:
            try:
                self._ctx.state.set(self._state_key(key), None)
            except Exception:
                logger.warning("talkto-plugin: could not delete the session's TalkTo state", exc_info=True)

    def _note_refused_injection(self, key: str) -> None:
        with self._lock:
            if key in self._warned_injection:
                return
            self._warned_injection.add(key)
        # inject_message returns only False, so Hermes's own warning just before this one names
        # the cause. Do not guess it here: the setting may well be on already.
        logger.warning(
            "talkto-plugin: Hermes did not start a turn for queued TalkTo messages in session %s; "
            "they wait for the next prompt in that session. Hermes's warning just before this one "
            "says why. 'not a live local session' means the session has ended (a one-shot "
            "'hermes chat -q' session ends after its turn); 'gateway injection denied' means "
            "plugins.entries.%s.allow_gateway_injection is not true.",
            key,
            PLUGIN_ID,
        )

    # -- tools and command ---------------------------------------------------------

    def follow_tool(self, args: Mapping[str, Any], **kwargs: Any) -> str:
        session_id = str(kwargs.get("session_id") or kwargs.get("task_id") or "")
        given = read_follow_input(args if isinstance(args, Mapping) else {})
        if isinstance(given, str):
            return json.dumps({"error": given})
        key = self._key_for(session_id)
        inbox = self._inbox(key, create=True)
        if inbox is None:
            return json.dumps({"error": "TalkTo could not start delivery for this session."})
        with self._lock:
            self._keys.setdefault(session_id, key)
            turn = self._turns.get(session_id)
        if turn is not None:
            # The follow happens inside a running turn: urgent messages may join it.
            inbox.mark_running(turn)
        return json.dumps({"message": inbox.follow(given)})

    def unfollow_tool(self, args: Mapping[str, Any], **kwargs: Any) -> str:
        server_id = args.get("serverId") if isinstance(args, Mapping) else None
        if not isinstance(server_id, str):
            return json.dumps({"error": "unfollow needs serverId."})
        session_id = str(kwargs.get("session_id") or kwargs.get("task_id") or "")
        inbox = self._inbox(self._key_for(session_id), create=False)
        if inbox is None:
            return json.dumps({"message": f"This session does not follow anyone on server {server_id}."})
        return json.dumps({"message": inbox.unfollow(server_id)})

    def inbox_command(self, raw_args: str = "", **kwargs: Any) -> str:
        del raw_args
        key = str(kwargs.get("session_key") or "") or self._key_for(str(kwargs.get("session_id") or ""))
        inbox = self._inbox(key, create=False) if key else None
        if inbox is None:
            return (
                "TalkTo: this session follows no participant. The agent starts delivery with "
                "talkto_follow after it joins a server."
            )
        return inbox.describe()

    # -- hooks ---------------------------------------------------------------------

    def on_pre_llm_call(self, **kwargs: Any) -> Optional[dict[str, str]]:
        if kwargs.get("parent_session_id"):
            return None  # a subagent's turn; the parent session's inbox is not its business
        session_id = str(kwargs.get("session_id") or "")
        turn_id = str(kwargs.get("turn_id") or "")
        with self._lock:
            if not turn_id:
                self._turn_count += 1
                turn_id = f"turn-{self._turn_count}"
            self._turns[session_id] = turn_id
        key = self._key_for(session_id)
        inbox = self._inbox(key, create=False)
        if inbox is None:
            return None
        with self._lock:
            self._keys[session_id] = key
        extra = inbox.on_turn_start(turn_id, _text_of(kwargs.get("user_message")))
        return {"context": extra} if extra else None

    def on_pre_api_request(self, **kwargs: Any) -> None:
        session_id = str(kwargs.get("session_id") or "")
        inbox = self._known(session_id)
        turn_id = str(kwargs.get("turn_id") or "") or self._turns.get(session_id, "")
        if inbox is None or not inbox.waiting_for_read(turn_id):
            return
        messages = kwargs.get("request_messages") or kwargs.get("conversation_history")
        inbox.confirm_read(turn_id, _recent_text(messages))

    def on_transform_tool_result(self, **kwargs: Any) -> Optional[str]:
        session_id = str(kwargs.get("session_id") or "")
        inbox = self._known(session_id)
        if inbox is None:
            return None
        given_turn = str(kwargs.get("turn_id") or "")
        with self._lock:
            turn_id = self._turns.get(session_id)
            if turn_id is None and given_turn and self._ended.get(session_id) != given_turn:
                # The plugin missed this turn's start (it loaded mid-turn, or the hook was
                # skipped): the session's own tool call says which turn runs.
                turn_id = self._turns[session_id] = given_turn
                adopted = True
            else:
                adopted = False
        if adopted:
            inbox.mark_running(given_turn)
        if turn_id is None or (given_turn and given_turn != turn_id):
            return None  # another agent's tool call, such as a subagent's
        urgent = inbox.take_urgent(turn_id)
        if urgent is None:
            return None
        result = kwargs.get("result")
        return f"{result if isinstance(result, str) else json.dumps(result)}\n\n{urgent}"

    def on_session_end(self, **kwargs: Any) -> None:
        session_id = str(kwargs.get("session_id") or "")
        with self._lock:
            running = self._turns.get(session_id)
            given = str(kwargs.get("turn_id") or "")
            if running is None or (given and given != running):
                return
            del self._turns[session_id]
            self._ended[session_id] = running
        inbox = self._known(session_id)
        if inbox is not None:
            inbox.on_turn_complete(running)

    def on_session_finalize(self, **kwargs: Any) -> None:
        """Hermes ended the session (the last viewer closed it, a one-shot finished, ``/new``)."""
        self._close(str(kwargs.get("session_id") or ""), forget=False)

    def on_session_delete(self, **kwargs: Any) -> None:
        self._close(str(kwargs.get("session_id") or ""), forget=True)

    def on_session_open(self, **kwargs: Any) -> None:
        session_id = str(kwargs.get("session_id") or "")
        if not session_id:
            return
        key = self._key_for(session_id)
        if self._inbox(key, create=False) is not None:
            with self._lock:
                self._keys[session_id] = key

    def on_post_compaction(self, **kwargs: Any) -> None:
        old, new = str(kwargs.get("old_session_id") or ""), str(kwargs.get("session_id") or "")
        if not old or not new or old == new:
            return
        with self._lock:
            if old in self._keys:
                self._keys[new] = self._keys[old]
            if old in self._turns:
                self._turns[new] = self._turns.pop(old)


class _HermesHost:
    """The inbox's Host for one Hermes session."""

    def __init__(self, plugin: TalkToPlugin, key: str) -> None:
        self._plugin = plugin
        self._key = key
        self.connection_hint = plugin._hint()

    def call(self, tool: str, args: Mapping[str, Any]) -> Answer:
        try:
            raw = self._plugin._ctx.call_mcp(
                self._plugin._server(), tool, dict(args), timeout=CALL_TIMEOUT
            )
        except PermissionError as cause:
            raise TransportError(str(cause)) from None
        except Exception as cause:
            raise TransportError(f"{type(cause).__name__}: {cause}") from None
        if not isinstance(raw, Mapping):
            raise TransportError("Hermes returned no MCP result")
        return _answer(raw)

    def submit(self, text: str) -> bool:
        accepted = bool(self._plugin._ctx.inject_message(text, role="user", session_key=self._key))
        if not accepted:
            self._plugin._note_refused_injection(self._key)
        return accepted

    def load(self) -> object:
        return self._plugin._ctx.state.get(self._plugin._state_key(self._key))

    def save(self, state: dict[str, Any]) -> None:
        empty = not state.get("follows") and not state.get("notes")
        try:
            self._plugin._ctx.state.set(self._plugin._state_key(self._key), None if empty else state)
        except Exception:
            logger.warning("talkto-plugin: could not save the session's TalkTo state", exc_info=True)

    def now(self) -> float:
        return self._plugin._deps.now()

    def after(self, ms: float, run: Callable[[], None]) -> None:
        self._plugin._deps.after(ms, run)
