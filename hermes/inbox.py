"""The session's TalkTo inbox: which participants this session follows, the
messages waiting for it, and when they are delivered.

A Python port of ``core/src/inbox.ts`` (the rules are the same; read that file's
header for the model). Hermes plugins run inside Hermes's own Python process, so
the TypeScript core cannot run here. Differences, all caused by Hermes's API:

- Urgent messages are *pulled* into the running turn. Hermes's
  ``transform_tool_result`` hook calls ``take_urgent`` after each tool call and
  appends the notice to that tool's result, so the model reads it at the turn's
  next request. There is no push (``Host.inject``) in Hermes.
- A notice counts as delivered only when Hermes shows it to the model: a queued
  notice when a turn starts with it as its prompt (``on_turn_start``), an urgent
  one when a model request carries it (``confirm_read``). An urgent notice that
  no request carried goes back to the queue, so it is never lost.
- When Hermes refuses a submitted turn (gateway injection is not granted, or the
  session is no longer live), the queue goes with the person's next prompt
  instead (``take_for_prompt``).
- Hermes's gateway outlives each session, so the plugin closes a session's inbox
  when Hermes ends the session (``close``); it stops polling and delivering, and
  a resumed session reads on from the saved checkpoint.
- Hermes truncates an MCP result over about 64 KB, so a truncated page is read
  again with fewer messages.
- Methods are synchronous and thread-safe. Network calls run without the lock.

Identity: a follow names the participant explicitly (the agent's own follow
call after it registered); the MCP connection identifies nobody.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Mapping, Optional, Protocol, Sequence, Union

from .notice import (
    BODY_LIMIT,
    follow_ended,
    is_newer,
    queued_notice,
    release_text,
    update_notice,
    urgent_notice,
)
from .version import VERSION
from .talkto import (
    IncomingMessage,
    ParticipantRename,
    UpdatesFailure,
    UpdatesPage,
    decode_updates,
)

Delivery = Literal["idle", "next-prompt"]
UrgentHandling = Literal["inject", "queue"]
WaitPolicy = Literal["auto", "always", "never"]
DirectChats = Literal["own", "none"]

#: Participants one session may follow at once (one per server).
FOLLOW_LIMIT = 4
#: Messages kept per follow; past this the oldest are counted as dropped.
QUEUE_LIMIT = 100
#: Pages read per follow per tick.
PAGES_PER_TICK = 4
#: Messages asked for per page; fewer when Hermes truncated the answer.
PAGE_LIMIT = 50
#: Idle time before a queued notice is submitted, so a person about to type goes first.
SETTLE_MILLIS = 2000
#: Seconds one poll may wait on the server; TalkTo's maximum.
WAIT_SECONDS = 20
#: How long after the last turn or message ``auto`` keeps waiting polls.
ENGAGED_MILLIS = 10 * 60 * 1000
#: Least time between the starts of two chained waiting polls.
REARM_MILLIS = 1000
#: How long an idle session has to start the turn for a submitted notice.
CONFIRM_MILLIS = 30_000
#: Longest wait between polls after repeated failures.
_BACKOFF_LIMIT_MILLIS = 5 * 60 * 1000
#: Least time between two notices that mention the same plugin update.
UPDATE_NOTICE_MILLIS = 24 * 60 * 60 * 1000
#: This plugin, as it names itself to TalkTo on every get_updates call.
PLUGIN_NAME = "hermes"
#: Failures that mean the follow can never work again as it stands.
_PERMANENT = frozenset(
    {
        "participant_not_found",
        "server_unavailable",
        "conversation_not_found",
        "wrong_conversation_kind",
        "invalid_input",
    }
)


@dataclass(frozen=True)
class Settings:
    delivery: Delivery = "idle"
    urgent: UrgentHandling = "inject"
    poll_millis: int = 15_000
    wait: WaitPolicy = "auto"


@dataclass(frozen=True)
class Answer:
    """A TalkTo tool answer: its JSON envelope (None when unreadable) and whether Hermes cut it."""

    envelope: object
    truncated: bool = False


class TransportError(Exception):
    """The call itself failed: TalkTo was not reached or Hermes refused the call."""


class Host(Protocol):
    """What the inbox needs from Hermes; ``plugin.py`` binds it."""

    #: What the agent should do when TalkTo cannot be reached.
    connection_hint: str

    def call(self, tool: str, args: Mapping[str, Any]) -> Answer:
        """Calls a TalkTo MCP tool through Hermes's connection; raises TransportError."""
        ...

    def submit(self, text: str) -> bool:
        """Asks Hermes to start a turn with ``text``; False when Hermes refused."""
        ...

    def load(self) -> object: ...

    def save(self, state: dict[str, Any]) -> None: ...

    def now(self) -> float:
        """Milliseconds."""
        ...

    def after(self, ms: float, run: Callable[[], None]) -> None:
        """Runs ``run`` once after ``ms``."""
        ...


@dataclass(frozen=True)
class FollowInput:
    server_id: str
    participant_id: str
    channel_ids: tuple[str, ...]
    direct_chats: DirectChats
    start_at: Literal["now", "beginning"]


@dataclass(eq=False)
class Follow:
    """One followed participant and its queue. Compared by identity: a replaced follow is another one."""

    server_id: str
    participant_id: str
    channel_ids: tuple[str, ...]
    direct_chats: DirectChats
    checkpoint: str
    pending: list[IncomingMessage] = field(default_factory=list)
    #: Messages that arrived while the queue was full; counted, not kept.
    dropped: int = 0
    #: Renames since the last notice, at most ``QUEUE_LIMIT``; they go with the next one.
    renames: list[ParticipantRename] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "server_id": self.server_id,
            "participant_id": self.participant_id,
            "channel_ids": list(self.channel_ids),
            "direct_chats": self.direct_chats,
            "checkpoint": self.checkpoint,
            "pending": [message.to_json() for message in self.pending],
            "dropped": self.dropped,
            "renames": [rename.to_json() for rename in self.renames],
        }

    @staticmethod
    def from_json(value: object) -> Optional["Follow"]:
        if not isinstance(value, Mapping):
            return None
        texts = [value.get(key) for key in ("server_id", "participant_id", "checkpoint")]
        channels, pending = value.get("channel_ids"), value.get("pending")
        direct_chats, dropped = value.get("direct_chats"), value.get("dropped")
        if not all(isinstance(text, str) for text in texts):
            return None
        if not isinstance(channels, list) or not all(isinstance(item, str) for item in channels):
            return None
        if direct_chats not in ("own", "none") or not isinstance(pending, list):
            return None
        if not isinstance(dropped, int) or isinstance(dropped, bool) or dropped < 0:
            return None
        messages = [IncomingMessage.from_json(item) for item in pending]
        kept = [message for message in messages if message is not None]
        if len(kept) != len(messages):
            return None
        # Absent in a session saved before renames were queued.
        saved_renames = value.get("renames", [])
        if not isinstance(saved_renames, list):
            return None
        renames = [ParticipantRename.from_json(item) for item in saved_renames]
        known = [rename for rename in renames if rename is not None]
        if len(known) != len(renames):
            return None
        server_id, participant_id, checkpoint = (str(text) for text in texts)
        return Follow(
            server_id=server_id,
            participant_id=participant_id,
            channel_ids=tuple(channels),
            direct_chats="own" if direct_chats == "own" else "none",
            checkpoint=checkpoint,
            pending=kept,
            dropped=dropped,
            renames=known,
        )


def read_saved(value: object) -> Optional[tuple[list[Follow], list[str]]]:
    """A session this version of the plugin saved, or None."""
    if not isinstance(value, Mapping) or value.get("version") != 1:
        return None
    follows, notes = value.get("follows"), value.get("notes")
    if not isinstance(follows, list) or not isinstance(notes, list):
        return None
    if not all(isinstance(note, str) for note in notes):
        return None
    decoded = [Follow.from_json(item) for item in follows]
    kept = [item for item in decoded if item is not None]
    if len(kept) != len(decoded):
        return None
    return kept, [str(note) for note in notes]


def read_follow_input(args: Mapping[str, Any]) -> Union[FollowInput, str]:
    """The follow tool's arguments decoded, or what is wrong with them."""
    server_id, participant_id = args.get("serverId"), args.get("participantId")
    if not isinstance(server_id, str) or not isinstance(participant_id, str):
        return (
            "follow needs serverId and participantId: your own participant, "
            "from register_participant or get_context."
        )
    channels = args.get("channelIds", [])
    if not isinstance(channels, list) or not all(isinstance(item, str) for item in channels):
        return "channelIds must be a list of channel IDs."
    direct_chats = args.get("directChats", "own")
    if direct_chats not in ("own", "none"):
        return 'directChats must be "own" or "none".'
    start_at = args.get("startAt", "now")
    if start_at not in ("now", "beginning"):
        return 'startAt must be "now" or "beginning".'
    return FollowInput(
        server_id=server_id,
        participant_id=participant_id,
        channel_ids=tuple(channels),
        direct_chats="own" if direct_chats == "own" else "none",
        start_at="now" if start_at == "now" else "beginning",
    )


def _keep(message: IncomingMessage) -> IncomingMessage:
    if len(message.body) <= BODY_LIMIT + 1:
        return message
    # One character past the limit tells the notice the body was cut.
    return IncomingMessage(**{**message.to_json(), "body": message.body[: BODY_LIMIT + 1]})


@dataclass(frozen=True)
class _Snapshot:
    """What one notice covered: the notes before it and the queued message IDs."""

    notes: int
    ids: frozenset[str]
    #: When it was sent, if it carried the plugin update line.
    update_at: Optional[float] = None


@dataclass
class _Submitted:
    """A queued notice Hermes accepted, until a turn starts with it."""

    text: str
    snapshot: _Snapshot
    deadline: float


@dataclass
class _Injected:
    """Urgent messages put into one turn, until a model request carries them."""

    turn_id: str
    server_id: str
    participant_id: str
    messages: list[IncomingMessage]


def _first_line(text: str) -> str:
    return text.split("\n", 1)[0]


class Inbox:
    def __init__(self, host: Host, settings: Settings) -> None:
        self._host = host
        self._settings = settings
        self._lock = threading.RLock()
        self._follows: list[Follow] = []
        self._notes: list[str] = []
        self._busy = False
        self._turn_id: Optional[str] = None
        self._idle_since = 0.0
        self._active_at = 0.0
        #: False once the server rejected waitSeconds (an older deployment).
        self._can_wait = True
        #: False once the server rejected the ``plugin`` field (before November 16, 2026).
        self._can_report = True
        #: The newest version of this plugin, from the latest page that said.
        self._latest_version: Optional[str] = None
        #: When a notice last carried the update line; None before the first.
        self._update_notice_at: Optional[float] = None
        self._chained = False
        self._submitting = False
        self._submitted: Optional[_Submitted] = None
        self._held_for_input = False
        self._polling = False
        self._failures = 0
        self._resume_at = 0.0
        self._injected: list[_Injected] = []
        #: True once Hermes ended the session: nothing polls or delivers any more.
        self._closed = False
        #: When this inbox last started a turn of its own; the person's wake cadence counts from it.
        self._last_wake_at = float("-inf")
        #: Each follow's cadence in milliseconds from its newest page, by server.
        self._cadence: dict[str, float] = {}
        self._cadence_timer = False

    # -- what the plugin and the agent use --------------------------------

    def restore(self) -> None:
        """Restores what this session followed and queued before a reload or restart."""
        stored = self._host.load()
        decoded = read_saved(stored)
        if decoded is None:
            return
        with self._lock:
            self._follows, self._notes = decoded
            self._update_notice_at = _update_notice_at(stored)
        if self._follows:
            self._host.after(0, self.tick)

    def close(self) -> None:
        """Hermes ended the session: stop polling and delivering, and keep what is saved.

        A session that is resumed later restores its follows and checkpoints and reads on from
        there, so nothing sent meanwhile is lost."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            unread = list(self._injected)
            self._injected = []
            for entry in unread:
                self._requeue(entry)
            if unread:
                self._persist()

    def follows(self) -> int:
        with self._lock:
            return len(self._follows)

    def follow(self, given: FollowInput) -> str:
        """Starts (or restarts) delivery for one participant; the answer is what the model reads."""
        with self._lock:
            if len(self._follows) >= FOLLOW_LIMIT and not any(
                item.server_id == given.server_id for item in self._follows
            ):
                return f"This session already follows {FOLLOW_LIMIT} participants. Call unfollow for one first."
        try:
            answer = self._updates(
                {
                    "serverId": given.server_id,
                    "participantId": given.participant_id,
                    "mode": "start",
                    "channelIds": list(given.channel_ids),
                    "directChats": given.direct_chats,
                    "startAt": given.start_at,
                },
                0,
            )
        except TransportError as cause:
            return f"Could not reach TalkTo ({cause}). {self._host.connection_hint} Then call follow again."
        reply = decode_updates(answer.envelope, given.participant_id)
        if isinstance(reply, UpdatesFailure):
            return f"TalkTo refused the follow: {reply.code}: {reply.message}"
        follow = Follow(
            server_id=given.server_id,
            participant_id=given.participant_id,
            channel_ids=given.channel_ids,
            direct_chats=given.direct_chats,
            checkpoint=reply.checkpoint,
            pending=[_keep(message) for message in reply.messages],
            renames=list(reply.renames),
        )
        with self._lock:
            self._follows = [
                item for item in self._follows if item.server_id != given.server_id
            ] + [follow]
            self._learn_cadence(given.server_id, reply)
            self._learn_latest(reply)
            self._active_at = self._host.now()
            self._persist()
        self._host.after(0, self.tick)
        waiting = len(follow.pending)
        more = "+" if reply.has_more else ""
        return " ".join(
            [
                f"Following participant {given.participant_id} on server {given.server_id} "
                f"({len(given.channel_ids)} channels, direct chats: {given.direct_chats}).",
                "New messages wait in a queue and arrive as one notice after you finish a turn; "
                "urgent direct messages arrive inside your running turn.",
                "Do not poll get_updates, create watches, or schedule checks for this participant "
                "while the plugin follows it.",
                f"{waiting}{more} earlier messages were found; they arrive after this turn."
                if waiting > 0 or reply.has_more
                else "Nothing is waiting yet.",
            ]
        )

    def unfollow(self, server_id: str) -> str:
        """Stops delivery for the participant this session follows on one server."""
        with self._lock:
            found = next((item for item in self._follows if item.server_id == server_id), None)
            if found is None:
                return f"This session does not follow anyone on server {server_id}."
            self._follows = [item for item in self._follows if item is not found]
            self._persist()
        return (
            f"Stopped following participant {found.participant_id} on server {server_id}. "
            f"{len(found.pending)} queued messages were discarded; they remain in TalkTo's history."
        )

    def describe(self) -> str:
        """A plain description for the person's slash command."""
        with self._lock:
            if not self._follows:
                return (
                    "TalkTo: this session follows no participant. The agent starts delivery with "
                    "the follow tool after it joins a server."
                )
            lines = [
                f"TalkTo: participant {item.participant_id} on server {item.server_id}: "
                f"{len(item.pending)} queued"
                f"{' (urgent waiting)' if any(m.is_urgent for m in item.pending) else ''}."
                for item in self._follows
            ]
            if self._held_for_input:
                lines.append(
                    "Hermes did not start a turn for them, so they arrive with your next prompt."
                )
            elif self._settings.delivery == "idle":
                lines.append("Queued messages arrive as a turn of their own when the session is idle.")
            else:
                lines.append("Queued messages arrive with your next prompt.")
            if self._update_available():
                lines.append(update_notice(PLUGIN_NAME, VERSION, self._latest_version or ""))
            return "\n".join(lines)

    # -- turn events from Hermes's hooks -----------------------------------

    def on_turn_start(self, turn_id: str, prompt: str) -> Optional[str]:
        """A turn starts with ``prompt``. Returns text to add to that prompt, or None."""
        with self._lock:
            submitted = self._submitted
            if submitted is not None and _first_line(submitted.text) in prompt:
                # Hermes started the turn for the notice: now it is delivered.
                self._submitted = None
                self._clear_delivered(submitted.snapshot)
                self._persist()
            extra = None
            if self._settings.delivery == "next-prompt" or self._held_for_input:
                extra = self._take_for_prompt()
            self._busy = True
            self._turn_id = turn_id
            self._held_for_input = False
        # Start waiting now rather than at the next timer tick, so an urgent message can reach this turn.
        self._host.after(0, self.tick)
        return extra

    def mark_running(self, turn_id: str) -> None:
        """A turn that started before this inbox existed is running; nothing is delivered for it."""
        with self._lock:
            if self._busy:
                return
            self._busy = True
            self._turn_id = turn_id

    def take_urgent(self, turn_id: str) -> Optional[str]:
        """After a tool call in the running turn: the urgent notice to add to its result, or None."""
        with self._lock:
            if not self._busy or self._turn_id != turn_id or self._settings.urgent != "inject":
                return None
            held = self._submitted.snapshot.ids if self._submitted is not None else frozenset()
            parts: list[str] = []
            for follow in self._follows:
                urgent = [m for m in follow.pending if m.is_urgent and m.id not in held]
                if not urgent:
                    continue
                parts.append(urgent_notice(follow, urgent))
                taken = {message.id for message in urgent}
                follow.pending = [m for m in follow.pending if m.id not in taken]
                self._injected.append(
                    _Injected(turn_id, follow.server_id, follow.participant_id, urgent)
                )
            if not parts:
                return None
            self._persist()
            return "\n\n---\n\n".join(parts)

    def waiting_for_read(self, turn_id: str) -> bool:
        """Whether an urgent notice of ``turn_id`` waits for a model request to carry it."""
        with self._lock:
            return any(entry.turn_id == turn_id for entry in self._injected)

    def confirm_read(self, turn_id: str, request_text: str) -> None:
        """A model request of ``turn_id`` is about to go out with ``request_text``."""
        with self._lock:
            self._injected = [
                entry
                for entry in self._injected
                if not (
                    entry.turn_id == turn_id
                    and f"messageId {entry.messages[0].id}" in request_text
                )
            ]

    def on_turn_complete(self, turn_id: str) -> None:
        with self._lock:
            if self._turn_id not in (None, turn_id):
                return
            self._busy = False
            self._turn_id = None
            self._idle_since = self._host.now()
            self._active_at = self._idle_since
            if self._submitted is not None:
                # Hermes runs the accepted notice after this turn: give it time again.
                self._submitted.deadline = self._idle_since + CONFIRM_MILLIS
            unread = [entry for entry in self._injected if entry.turn_id == turn_id]
            self._injected = [entry for entry in self._injected if entry.turn_id != turn_id]
            for entry in unread:
                self._requeue(entry)
            if unread:
                self._persist()
        self._host.after(SETTLE_MILLIS, self.deliver)

    # -- polling -------------------------------------------------------------

    def tick(self) -> None:
        """One tick: poll every follow at once, then deliver what is due."""
        with self._lock:
            if self._closed or self._polling or not self._follows:
                return
            now = self._host.now()
            if now < self._resume_at:
                return
            self._polling = True
            follows = list(self._follows)
            wait = self._wait_for(now)
            before = self._queued()
        failed = False
        try:
            results = _parallel([lambda f=follow: self._poll(f, wait) for follow in follows])
            failed = not all(results)
            with self._lock:
                self._failures = self._failures + 1 if failed else 0
                self._resume_at = (
                    now
                    + min(_BACKOFF_LIMIT_MILLIS, self._settings.poll_millis * 2**self._failures)
                    if failed
                    else 0
                )
                if self._queued() > before:
                    self._active_at = self._host.now()
                # A poll that ends after the session closed saves nothing: the saved checkpoint
                # stays before these messages, so a resumed session reads them again.
                if not self._closed:
                    self._persist()
        finally:
            with self._lock:
                self._polling = False
        self.deliver()
        if not failed:
            self._chain(now)

    def _wait_for(self, now: float) -> int:
        if not self._can_wait or self._settings.wait == "never":
            return 0
        engaged = self._busy or now - self._active_at < ENGAGED_MILLIS
        return WAIT_SECONDS if self._settings.wait == "always" or engaged else 0

    def _chain(self, started: float) -> None:
        with self._lock:
            now = self._host.now()
            if self._closed or self._chained or not self._follows or self._wait_for(now) == 0:
                return
            self._chained = True

        def again() -> None:
            with self._lock:
                self._chained = False
            self.tick()

        self._host.after(max(0.0, REARM_MILLIS - (now - started)), again)

    def _queued(self) -> int:
        return sum(len(follow.pending) for follow in self._follows)

    def _read(self, args: Mapping[str, Any]) -> Answer:
        """One get_updates call; a page Hermes truncated is read again with fewer messages."""
        limit = PAGE_LIMIT
        current = dict(args)
        while True:
            answer = self._host.call("get_updates", {**current, "limit": limit})
            if not answer.truncated or limit == 1:
                return answer
            limit = max(1, limit // 4)
            # A cut answer had messages to read, so the retry need not wait.
            current.pop("waitSeconds", None)

    def _page(self, follow: Follow, wait: int) -> Answer:
        return self._updates(
            {
                "serverId": follow.server_id,
                "participantId": follow.participant_id,
                "mode": "poll",
                "checkpoint": follow.checkpoint,
            },
            wait,
        )

    def _updates(self, args: Mapping[str, Any], wait: int) -> Answer:
        """One get_updates call with this plugin's name and version, and ``waitSeconds`` when it may
        wait. An older server refuses fields it does not know (``invalid_input``): it is asked again
        without ``plugin``, then without ``waitSeconds``, and what it refused is not sent again."""
        waiting: dict[str, Any] = {"waitSeconds": wait} if wait > 0 else {}
        if not self._can_report:
            answer = self._read({**args, **waiting})
            if wait == 0 or not _refused(answer):
                return answer
            with self._lock:
                self._can_wait = False
            return self._read(args)
        reported = self._read({**args, **waiting, "plugin": release_text(PLUGIN_NAME, VERSION)})
        if not _refused(reported):
            return reported
        unreported = self._read({**args, **waiting})
        if not _refused(unreported):
            with self._lock:
                self._can_report = False
            return unreported
        if wait == 0:
            return unreported
        plain = self._read(args)
        if not _refused(plain):
            # A server without waitSeconds predates the plugin field too.
            with self._lock:
                self._can_wait = False
                self._can_report = False
        return plain

    def _poll(self, follow: Follow, wait: int) -> bool:
        """Reads one follow's new messages into its queue; False on a failure worth retrying."""
        for page in range(PAGES_PER_TICK):
            try:
                # Only the first page waits; a continuation already has messages to read.
                answer = self._page(follow, wait if page == 0 else 0)
            except TransportError:
                return False
            reply = decode_updates(answer.envelope, follow.participant_id)
            if isinstance(reply, UpdatesFailure):
                return self._failed(follow, reply)
            with self._lock:
                if follow not in self._follows:
                    return True  # unfollowed or replaced while the call ran
                self._take_page(follow, reply)
            if not reply.has_more:
                break
        return True

    def _take_page(self, follow: Follow, page: UpdatesPage) -> None:
        known = {message.id for message in follow.pending}
        for message in page.messages:
            if message.id not in known:
                follow.pending.append(_keep(message))
        over = len(follow.pending) - QUEUE_LIMIT
        if over > 0:
            follow.pending = follow.pending[over:]
            follow.dropped += over
        renamed = {rename.id for rename in follow.renames}
        follow.renames.extend(rename for rename in page.renames if rename.id not in renamed)
        follow.renames = follow.renames[-QUEUE_LIMIT:]
        follow.checkpoint = page.checkpoint
        self._learn_cadence(follow.server_id, page)
        self._learn_latest(page)

    def _learn_latest(self, page: UpdatesPage) -> None:
        # A page without the field (an older server, or a call without ``plugin``) leaves what is known.
        if page.latest_plugin_version is not None:
            self._latest_version = page.latest_plugin_version

    def _update_available(self) -> bool:
        """Whether TalkTo said a newer version of this plugin exists."""
        return self._latest_version is not None and is_newer(self._latest_version, VERSION)

    def _update_due(self, now: float) -> bool:
        """Whether the next notice should carry the update line: an update exists and a day passed."""
        return self._update_available() and (
            self._update_notice_at is None or now - self._update_notice_at >= UPDATE_NOTICE_MILLIS
        )

    def _learn_cadence(self, server_id: str, page: UpdatesPage) -> None:
        # A page without the field (an older server) leaves what is known; none known means none.
        if page.wake_interval_seconds is not None:
            self._cadence[server_id] = page.wake_interval_seconds * 1000

    def _cadence_wait(self, now: float) -> float:
        """How long the person's cadence still holds the next turn back: zero once any follow with
        queued messages may wake, else the shortest wait among them."""
        waits = [
            max(0.0, self._last_wake_at + self._cadence.get(item.server_id, 0) - now)
            for item in self._follows
            if item.pending or item.dropped
        ]
        return min(waits) if waits else 0.0

    def _failed(self, follow: Follow, failure: UpdatesFailure) -> bool:
        """Ends a follow TalkTo will never accept again; anything else is retried."""
        if failure.code == "invalid_cursor":
            # The server's history was restored: start again from now and say what may be missing.
            try:
                restarted = self._updates(
                    {
                        "serverId": follow.server_id,
                        "participantId": follow.participant_id,
                        "mode": "start",
                        "channelIds": list(follow.channel_ids),
                        "directChats": follow.direct_chats,
                        "startAt": "now",
                    },
                    0,
                )
            except TransportError:
                return False
            reply = decode_updates(restarted.envelope, follow.participant_id)
            if isinstance(reply, UpdatesFailure):
                return self._failed(follow, reply)
            with self._lock:
                follow.checkpoint = reply.checkpoint
                self._notes.append(
                    f"TalkTo: the server's history position for participant {follow.participant_id} "
                    f"was reset ({failure.message}). Messages sent around the reset may not have been "
                    "delivered; read recent history with read_messages."
                )
            return True
        if failure.code not in _PERMANENT:
            return False
        with self._lock:
            self._follows = [item for item in self._follows if item is not follow]
            self._notes.append(follow_ended(follow, f"{failure.code}: {failure.message}"))
        return True

    # -- delivery ------------------------------------------------------------

    def deliver(self) -> None:
        """Submits everything queued as one turn of its own, once the session is idle."""
        with self._lock:
            if self._closed or self._busy or self._submitting or self._held_for_input:
                return
            now = self._host.now()
            if self._submitted is not None:
                if now < self._submitted.deadline:
                    return
                # No turn started for it: let the person's next prompt carry the queue.
                self._submitted = None
                self._held_for_input = True
                return
            if now - self._idle_since < SETTLE_MILLIS:
                return
            has_urgent = any(m.is_urgent for follow in self._follows for m in follow.pending)
            # With next-prompt delivery only urgent messages wake an idle session.
            if self._settings.delivery == "next-prompt" and not has_urgent and not self._notes:
                return
            update = self._update_due(now)
            text = self._notice_text(frozenset(), renames_alone=False, update=update)
            if text is None:
                return
            held = 0.0 if has_urgent or self._notes else self._cadence_wait(now)
            if held > 0:
                # Urgent messages and plugin notes ignore the cadence; the rest wait for it.
                if not self._cadence_timer:
                    self._cadence_timer = True
                    self._host.after(held, self._cadence_due)
                return
            snapshot = self._snapshot(now if update else None)
            self._submitting = True
        accepted: Optional[bool]
        try:
            accepted = self._host.submit(text)
        except Exception:
            accepted = None  # not delivered: the queue is unchanged and the next tick tries again
        with self._lock:
            self._submitting = False
            if accepted is True:
                self._last_wake_at = now
                self._submitted = _Submitted(text, snapshot, self._host.now() + CONFIRM_MILLIS)
                self._host.after(CONFIRM_MILLIS, self.deliver)
            elif accepted is False:
                self._held_for_input = True

    def _cadence_due(self) -> None:
        with self._lock:
            self._cadence_timer = False
        self.deliver()

    def _take_for_prompt(self) -> Optional[str]:
        held = self._submitted.snapshot.ids if self._submitted is not None else frozenset()
        now = self._host.now()
        update = self._update_due(now)
        text = self._notice_text(held, renames_alone=True, update=update)
        if text is None:
            return None
        snapshot = self._snapshot(now if update else None)
        self._clear_delivered(_Snapshot(snapshot.notes, snapshot.ids - held, snapshot.update_at))
        self._persist()
        return text

    def _notice_text(
        self, without: frozenset[str], renames_alone: bool, update: bool = False
    ) -> Optional[str]:
        """The combined notice for everything queued except ``without``, or None. Queued renames go
        with any notice; on their own they make one only when ``renames_alone`` (the person's
        prompt carries it)."""
        parts = list(self._notes)
        waking = bool(parts)
        for follow in self._follows:
            messages = [m for m in follow.pending if m.id not in without]
            renames = [r for r in follow.renames if r.id not in without]
            waking = waking or bool(messages) or follow.dropped > 0
            if messages or follow.dropped > 0 or renames:
                parts.append(queued_notice(follow, messages, follow.dropped, renames))
        if not waking and not (renames_alone and parts):
            return None
        if not parts:
            return None
        text = "\n\n---\n\n".join(parts)
        if update:
            text += "\n\n" + update_notice(PLUGIN_NAME, VERSION, self._latest_version or "")
        return text

    def _snapshot(self, update_at: Optional[float] = None) -> _Snapshot:
        return _Snapshot(
            update_at=update_at,
            notes=len(self._notes),
            ids=frozenset(
                [m.id for follow in self._follows for m in follow.pending]
                + [r.id for follow in self._follows for r in follow.renames]
            ),
        )

    def _clear_delivered(self, snapshot: _Snapshot) -> None:
        if snapshot.update_at is not None:
            self._update_notice_at = snapshot.update_at
        self._notes = self._notes[snapshot.notes :]
        for follow in self._follows:
            follow.pending = [m for m in follow.pending if m.id not in snapshot.ids]
            follow.renames = [r for r in follow.renames if r.id not in snapshot.ids]
            follow.dropped = 0

    def _requeue(self, entry: _Injected) -> None:
        follow = next(
            (
                item
                for item in self._follows
                if item.server_id == entry.server_id and item.participant_id == entry.participant_id
            ),
            None,
        )
        if follow is None:
            return
        known = {message.id for message in follow.pending}
        follow.pending = [m for m in entry.messages if m.id not in known] + follow.pending

    def _persist(self) -> None:
        saved: dict[str, Any] = {
            "version": 1,
            "follows": [follow.to_json() for follow in self._follows],
            "notes": list(self._notes),
        }
        if self._update_notice_at is not None:
            saved["updateNoticeAt"] = self._update_notice_at
        self._host.save(saved)


def _refused(answer: Answer) -> bool:
    """Whether TalkTo refused a call's input (``invalid_input``), as a server older than a field does."""
    reply = decode_updates(answer.envelope, "")
    return isinstance(reply, UpdatesFailure) and reply.code == "invalid_input"


def _update_notice_at(stored: object) -> Optional[float]:
    """When a saved session last told the agent about a plugin update, or None."""
    if not isinstance(stored, Mapping):
        return None
    value = stored.get("updateNoticeAt")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _parallel(runs: Sequence[Callable[[], bool]]) -> list[bool]:
    """Runs each poll on its own thread, since each may wait up to 20 seconds on TalkTo."""
    results = [False] * len(runs)

    def run(index: int) -> None:
        try:
            results[index] = runs[index]()
        except Exception:
            results[index] = False

    if len(runs) == 1:
        run(0)
        return results
    threads = [
        threading.Thread(target=run, args=(index,), daemon=True, name="talkto-poll")
        for index in range(len(runs))
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results
