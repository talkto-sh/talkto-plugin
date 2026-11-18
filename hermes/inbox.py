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
- Hermes gives a plugin no timer of its own, so the inbox arranges every next
  check itself: a waiting poll right after the last one, or, when polls cannot
  wait (an older server, or ``wait: never``), a check every ``poll_millis``,
  and after a failed check, one when the backoff ends.
- Methods are synchronous and thread-safe. Network calls run without the lock.

Identity: a follow names the participant explicitly (the agent's own follow
call after it registered); the MCP connection identifies nobody.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Literal, Mapping, Optional, Protocol, Sequence, Union

from .notice import (
    BODY_FLOOR,
    BODY_LIMIT,
    TALLY_RECENT,
    TALLY_SENDERS,
    HeldMessage,
    Tally,
    follow_ended,
    held_summary,
    preview_of,
    is_newer,
    participant_removed,
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
    general_id_of,
    server_name_of,
)

Delivery = Literal["idle", "next-prompt"]
UrgentHandling = Literal["inject", "queue"]
#: Whether polls wait on the server: whenever following (the default), or never.
WaitPolicy = Literal["always", "never"]
DirectChats = Literal["own", "none"]

#: Participants one session may follow at once (one per server).
FOLLOW_LIMIT = 4
#: Channels one follow may watch: TalkTo's limit for get_updates.
CHANNEL_LIMIT = 32
#: Messages kept per follow; past this the oldest are counted as dropped.
QUEUE_LIMIT = 100
#: Pages read per follow per tick.
PAGES_PER_TICK = 4
#: Messages asked for per page; fewer when Hermes truncated the answer.
PAGE_LIMIT = 50
#: Idle time before a queued notice is submitted, so a person about to type goes first.
SETTLE_MILLIS = 2000
#: Seconds one poll may wait on the server; the most TalkTo publishes to every client.
WAIT_SECONDS = 20
#: Seconds one poll asks to wait while it may: TalkTo lets any call that names a plugin wait this
#: long (since November 17, 2026). When TalkTo refuses it, or Hermes or a proxy cuts a long wait
#: short, the check is asked again at once with ``WAIT_SECONDS``, and polls wait ``WAIT_SECONDS``
#: for ``LONG_WAIT_RETRY_MILLIS``.
LONG_WAIT_SECONDS = 50
#: A long wait that fails after this long was cut short by Hermes or a proxy, whatever the failure
#: says: TalkTo's own failures come at once. A gateway that ends a held call may answer with a body
#: that names nothing, such as a JSON 504.
CUT_MILLIS = 25_000
#: Long waits that fail in a row, for any reason, after which the last is taken as cut short.
LONG_WAIT_TRIES = 2
#: How long polls wait ``WAIT_SECONDS`` after a long wait was refused or cut short; then a long
#: wait is tried again, so a laptop that slept or a network that changed during one long wait does
#: not cost long waits for the whole session.
LONG_WAIT_RETRY_MILLIS = 30 * 60 * 1000
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
#: Failures that mean the follow can never work again as it stands; ``forbidden`` is a participant
#: TalkTo will not deliver to, such as a person's.
_PERMANENT = frozenset(
    {
        "participant_not_found",
        "server_unavailable",
        "conversation_not_found",
        "wrong_conversation_kind",
        "invalid_input",
        "forbidden",
    }
)
#: A person removed the participant on the dashboard; it ends the follow with its own notice.
_REMOVED = "participant_removed"


def wait_policy_of(setting: object) -> WaitPolicy:
    """The wait policy a person's setting names. Anything but ``never`` waits: ``auto``, the default
    before 0.3.4, waited only while the session was engaged and is now the same as ``always``."""
    return "never" if setting == "never" else "always"


#: Hermes's defaults for held channel messages (those that do not concern the participant): its
#: prompt cache lives 5 minutes after the last model call (``prompt_caching.cache_ttl``), and held
#: messages wait at most 4 minutes. They go with any notice that wakes the session anyway, else
#: after ``DEFAULT_BATCH_MINUTES``, or just before the cache expires, whichever is first, and never
#: into a session whose cache has expired. The core keeps every host's values in ``hostTimings``;
#: a test holds these to it.
DEFAULT_CACHE_MINUTES = 5
DEFAULT_BATCH_MINUTES = 4
#: Minutes a person may set for either value.
_TIMING_RANGE = (1, 24 * 60)


def minutes_setting(setting: object) -> Optional[float]:
    """A person's setting in minutes as milliseconds, kept within range; None when unset."""
    if isinstance(setting, bool):
        return None
    if isinstance(setting, (int, float)):
        minutes = float(setting)
    elif isinstance(setting, str) and setting.strip():
        try:
            minutes = float(setting)
        except ValueError:
            return None
    else:
        return None
    if minutes != minutes or minutes in (float("inf"), float("-inf")):
        return None
    return max(_TIMING_RANGE[0], min(_TIMING_RANGE[1], minutes)) * 60_000


def cache_margin_of(cache_millis: float) -> float:
    """How long before the cache expires a held batch is sent: a fifth of its life, at most 10 min."""
    return min(10 * 60_000, cache_millis / 5)


@dataclass(frozen=True)
class Settings:
    delivery: Delivery = "idle"
    urgent: UrgentHandling = "inject"
    poll_millis: int = 15_000
    wait: WaitPolicy = "always"
    #: The longest a held channel message waits while the cache is warm, in milliseconds.
    channel_batch_millis: float = DEFAULT_BATCH_MINUTES * 60_000
    #: How long the prompt cache lives after the last model call, in milliseconds.
    cache_millis: float = DEFAULT_CACHE_MINUTES * 60_000


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
    #: Channels watched quietly: their messages are held unless they @mention the participant.
    channel_ids: tuple[str, ...]
    direct_chats: DirectChats
    start_at: Literal["now", "beginning"]
    #: Channels whose every message is delivered.
    full_channel_ids: tuple[str, ...] = ()


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
    #: The watched channels whose every message is delivered. None for a follow started before
    #: plugin 0.3.5, when every watched channel delivered: all but General still do.
    full_channel_ids: Optional[tuple[str, ...]] = None
    #: Channel messages held instead of delivered since the last notice, one tally per channel.
    quiet: list[Tally] = field(default_factory=list)
    #: When the first of the held messages arrived, in milliseconds; None while none is held.
    quiet_since: Optional[float] = None

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
            "full_channel_ids": None
            if self.full_channel_ids is None
            else list(self.full_channel_ids),
            "quiet": [tally.to_json() for tally in self.quiet],
            "quiet_since": self.quiet_since,
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
        # Absent in a follow saved before plugin 0.3.5.
        full = value.get("full_channel_ids")
        if full is not None and (
            not isinstance(full, list) or not all(isinstance(item, str) for item in full)
        ):
            return None
        saved_quiet = value.get("quiet", [])
        if not isinstance(saved_quiet, list):
            return None
        tallies = [Tally.from_json(item) for item in saved_quiet]
        quiet = [tally for tally in tallies if tally is not None]
        if len(quiet) != len(tallies):
            return None
        since = value.get("quiet_since")
        if since is not None and (isinstance(since, bool) or not isinstance(since, (int, float))):
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
            full_channel_ids=None if full is None else tuple(full),
            quiet=quiet,
            quiet_since=None if not quiet or since is None else float(since),
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


@dataclass(frozen=True)
class Watched:
    """The channels a follow watches, from the agent's choice and the server's General channel."""

    #: The chosen channels without repeats, with General added when it is known.
    channel_ids: tuple[str, ...]
    #: Whether General is among them.
    general: bool
    #: The chosen channel left out so General fits within CHANNEL_LIMIT, or None.
    displaced: Optional[str]


def watched_channels(chosen: Sequence[str], general: Optional[str]) -> Watched:
    """Adds General to the chosen channels: TalkTo announces every new channel there. With
    CHANNEL_LIMIT channels chosen and General not among them, General takes the last one's place.
    When General is unknown (None), the choice stands as it is."""
    unique = tuple(dict.fromkeys(chosen))
    if general is None:
        return Watched(unique, False, None)
    if general in unique:
        return Watched(unique, True, None)
    displaced = unique[CHANNEL_LIMIT - 1] if len(unique) >= CHANNEL_LIMIT else None
    return Watched((general, *unique[: CHANNEL_LIMIT - 1]), True, displaced)


def _general_note(watched: Watched) -> str:
    """What the follow answer says about General."""
    if not watched.general:
        return (
            "TalkTo did not name this server's General channel, so the plugin could not add it; "
            "to hear about new channels, add General's ID from get_context to channelIds."
        )
    if watched.displaced is None:
        return "General is always watched: TalkTo announces new channels there."
    return (
        f"General is always watched and took one of the {CHANNEL_LIMIT} channel places, so channel "
        f"{watched.displaced} is not watched; to keep it, follow again with at most "
        f"{CHANNEL_LIMIT - 1} other channels."
    )


def _minutes_text(minutes: float) -> str:
    """Minutes as the core's template literal writes them: 4, 2.5."""
    return str(int(minutes)) if minutes == int(minutes) else repr(minutes)


def wake_rules(full: int, general_in_full: bool, batch_millis: float) -> str:
    """What the follow answer says wakes the agent, with ``full`` channels followed in full."""
    minutes = batch_millis / 60_000
    if full == 0:
        first = "Direct chats, @mentions of you and TalkTo's notices (such as a new channel) wake you."
    else:
        channels = "fullChannelIds channel" if full == 1 else f"{full} fullChannelIds channels"
        general = " (General included)" if general_in_full else ""
        first = (
            "Direct chats, @mentions of you, TalkTo's notices (such as a new channel) and every "
            f"message in your {channels}{general} wake you."
        )
    others = "" if general_in_full else ", General's included,"
    within = "a minute" if minutes == 1 else f"{_minutes_text(minutes)} minutes"
    return (
        f"{first} Other channel messages{others} are held: a short summary (sender, first line, "
        f"messageId) goes with your next notice, or on its own within {within} while you are "
        "active; read_messages shows them in full."
    )


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
    full = args.get("fullChannelIds", [])
    if not isinstance(full, list) or not all(isinstance(item, str) for item in full):
        return "fullChannelIds must be a list of channel IDs."
    if len(set(channels) | set(full)) > CHANNEL_LIMIT:
        return f"channelIds and fullChannelIds hold at most {CHANNEL_LIMIT} channels together."
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
        full_channel_ids=tuple(full),
    )


#: Body characters one follow's queue keeps in all; past this each new message keeps
#: ``BODY_FLOOR``, so a burst of long messages cannot make the saved state large.
QUEUE_BODY_BUDGET = 64_000


def _enqueue(pending: list[IncomingMessage], messages: Sequence[IncomingMessage]) -> None:
    """Adds messages to a queue, each body cut to what the queue may still keep."""
    kept = sum(len(message.body) for message in pending)
    for message in messages:
        limit = BODY_LIMIT if kept < QUEUE_BODY_BUDGET else BODY_FLOOR
        queued = (
            message
            if len(message.body) <= limit
            else replace(message, body=message.body[:limit], cut=True)
        )
        pending.append(queued)
        kept += len(queued.body)


#: Held message IDs remembered, so a page read twice is not held twice.
_COUNTED_LIMIT = 1000


def _tally(quiet: list[Tally], message: IncomingMessage) -> None:
    """Holds one channel message the session does not get in full, in its channel's tally."""
    # "planner (codex)" is named "planner": a name holds no spaces or parentheses.
    sender = re.sub(r" \(.*\)$", "", message.sender)
    held = HeldMessage(message.id, sender, preview_of(message.body))
    for index, current in enumerate(quiet):
        if current.conversation_id != message.conversation_id:
            continue
        keep = sender in current.senders or len(current.senders) > TALLY_SENDERS
        quiet[index] = replace(
            current,
            count=current.count + 1,
            recent=(*current.recent, held)[-TALLY_RECENT:],
            senders=current.senders if keep else (*current.senders, sender),
        )
        return
    quiet.append(Tally(message.conversation_id, message.where, 1, (sender,), (held,)))


def _tally_key(server_id: str, conversation_id: str) -> str:
    return f"{server_id} {conversation_id}"


@dataclass(frozen=True)
class _Snapshot:
    """What one notice covered: the notes before it and the queued message IDs."""

    notes: int
    ids: frozenset[str]
    #: When it was sent, if it carried the plugin update line.
    update_at: Optional[float] = None
    #: The held counts it showed, by server and conversation (``_tally_key``).
    tallies: Mapping[str, int] = field(default_factory=dict)
    #: When it was taken: held messages it did not show start a new window then.
    at: float = 0.0


@dataclass
class _Submitted:
    """A queued notice Hermes accepted, until a turn starts with it."""

    text: str
    snapshot: _Snapshot
    deadline: float


@dataclass(frozen=True, eq=False)
class _Run:
    """One follow's check in flight. A check whose run was removed or replaced was given up (the
    follow started again), and what it finds changes nothing."""

    server_id: str
    #: When it started, in milliseconds.
    since: float


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
        #: False once the server rejected waitSeconds (an older deployment).
        self._can_wait = True
        #: False once the server rejected the ``plugin`` field (before November 16, 2026).
        self._can_report = True
        #: When polls may wait ``LONG_WAIT_SECONDS`` again; until then they wait ``WAIT_SECONDS``.
        #: Set ``LONG_WAIT_RETRY_MILLIS`` ahead when a long wait was refused or cut short.
        self._long_waits_from = 0.0
        #: Long waits that failed in a row, for any reason; ``LONG_WAIT_TRIES`` count as a cut.
        self._long_wait_failures = 0
        #: The newest version of this plugin, from the latest page that said.
        self._latest_version: Optional[str] = None
        #: When a notice last carried the update line; None before the first.
        self._update_notice_at: Optional[float] = None
        #: Servers whose follow's next check is already arranged.
        self._chained: set[str] = set()
        self._submitting = False
        self._submitted: Optional[_Submitted] = None
        self._held_for_input = False
        #: Each follow's check in flight, by server.
        self._running: dict[str, _Run] = {}
        #: Each follow's failed checks in a row and when it may check again, by server.
        self._backoff: dict[str, tuple[int, float]] = {}
        self._injected: list[_Injected] = []
        #: True once Hermes ended the session: nothing polls or delivers any more.
        self._closed = False
        #: When this inbox last started a turn of its own; the person's wake cadence counts from it.
        self._last_wake_at = float("-inf")
        #: Each follow's cadence in milliseconds from its newest page, by server.
        self._cadence: dict[str, float] = {}
        self._cadence_timer = False
        #: Each server's General channel, by server, once get_context named it.
        self._generals: dict[str, str] = {}
        #: Servers of restored follows not yet checked for General, which plugins before 0.3.1
        #: left out.
        self._unchecked: set[str] = set()
        #: A restored follow's checkpoint and selection with General added, by server. The follow
        #: moves to it once its old checkpoint is read to the end.
        self._widening: dict[str, tuple[str, tuple[str, ...]]] = {}
        #: Each server's name, by server, once get_context named it; only notices use it.
        self._server_names: dict[str, str] = {}
        #: The newest held message IDs, at most ``_COUNTED_LIMIT``, so none is held twice.
        self._counted: dict[str, None] = {}
        #: When the session's last turn ended, the best measure of its last model call, from which
        #: Hermes times its prompt cache. None before the first turn end this inbox saw.
        self._last_turn_at: Optional[float] = None
        #: Whether a timer for a held batch is set.
        self._batch_timer = False

    # -- what the plugin and the agent use --------------------------------

    def restore(self) -> None:
        """Restores what this session followed and queued before a reload or restart."""
        stored = self._host.load()
        decoded = read_saved(stored)
        if decoded is None:
            return
        with self._lock:
            self._follows, self._notes = decoded
            now = self._host.now()
            for follow in self._follows:
                if follow.quiet and follow.quiet_since is None:
                    follow.quiet_since = now
            self._unchecked = {follow.server_id for follow in self._follows}
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
        general = self._general_of(given.server_id)
        # Full channels first, so General displaces a quiet one first.
        chosen = tuple(dict.fromkeys((*given.full_channel_ids, *given.channel_ids)))
        watched = watched_channels(chosen, general)
        full = tuple(
            item for item in dict.fromkeys(given.full_channel_ids) if item in watched.channel_ids
        )
        try:
            answer = self._updates(
                {
                    "serverId": given.server_id,
                    "participantId": given.participant_id,
                    "mode": "start",
                    "channelIds": list(watched.channel_ids),
                    "directChats": given.direct_chats,
                    "startAt": given.start_at,
                },
                0,
            )
        except TransportError as cause:
            return f"Could not reach TalkTo ({cause}). {self._host.connection_hint} Then call follow again."
        reply = decode_updates(answer.envelope, given.participant_id)
        if isinstance(reply, UpdatesFailure) and reply.code == _REMOVED:
            with self._lock:
                name = self._server_names.get(given.server_id)
            return participant_removed(given, name)
        if isinstance(reply, UpdatesFailure):
            return f"TalkTo refused the follow: {reply.code}: {reply.message}"
        follow = Follow(
            server_id=given.server_id,
            participant_id=given.participant_id,
            channel_ids=watched.channel_ids,
            direct_chats=given.direct_chats,
            checkpoint=reply.checkpoint,
            renames=list(reply.renames),
            full_channel_ids=full,
        )
        with self._lock:
            self._take(follow, reply.messages)
            self._follows = [
                item for item in self._follows if item.server_id != given.server_id
            ] + [follow]
            self._unchecked.discard(given.server_id)
            self._widening.pop(given.server_id, None)
            # A follow restarts delivery now: its check still in flight is given up, and the wait
            # after its earlier failures is dropped, so the next tick polls it at once.
            self._running.pop(given.server_id, None)
            self._backoff.pop(given.server_id, None)
            self._learn_cadence(given.server_id, reply)
            self._learn_latest(reply)
            self._persist()
        self._host.after(0, self.tick)
        waiting = len(follow.pending)
        held = sum(tally.count for tally in follow.quiet)
        more = "+" if reply.has_more else ""
        return " ".join(
            [
                f"Following participant {given.participant_id} on server {given.server_id} "
                f"({len(watched.channel_ids)} channels, {len(full)} of them in full, "
                f"direct chats: {given.direct_chats}).",
                _general_note(watched),
                wake_rules(
                    len(full),
                    general is not None and general in full,
                    self._settings.channel_batch_millis,
                ),
                "New messages wait in a queue and arrive as one notice after you finish a turn; "
                "urgent direct messages arrive inside your running turn.",
                "Do not poll get_updates, create watches, or schedule checks for this participant "
                "while the plugin follows it.",
                f"{waiting}{more} earlier messages were found; they arrive after this turn."
                if waiting > 0 or reply.has_more
                else "Nothing is waiting yet.",
                *(
                    [f"{held} earlier channel messages were held; a summary of them follows."]
                    if held > 0
                    else []
                ),
            ]
        )

    def _general_of(self, server_id: str) -> Optional[str]:
        """The server's General channel, asked of get_context once per server; None when TalkTo did not say."""
        with self._lock:
            known = self._generals.get(server_id)
        if known is not None:
            return known
        try:
            envelope = self._host.call("get_context", {"serverId": server_id}).envelope
        except TransportError:
            return None
        found = general_id_of(envelope)
        name = server_name_of(envelope)
        with self._lock:
            if found is not None:
                self._generals[server_id] = found
            if name is not None:
                self._server_names[server_id] = name
        return found

    def _name_of_server(self, server_id: str) -> Optional[str]:
        """The server's name for a notice: known since its follow, or asked of get_context now."""
        with self._lock:
            known = self._server_names.get(server_id)
        if known is not None:
            return known
        try:
            return server_name_of(self._host.call("get_context", {"serverId": server_id}).envelope)
        except TransportError:
            return None

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
                f"{' (urgent waiting)' if any(m.is_urgent for m in item.pending) else ''}"
                + (
                    f"; {sum(t.count for t in item.quiet)} channel messages held for a summary."
                    if item.quiet
                    else "."
                )
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
            self._last_turn_at = self._idle_since
            # The cache is warm again: held messages get a deadline, or a later one.
            self._arm_batch(self._idle_since)
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
        """One tick: check every follow that has no check in flight, each on its own. A follow's
        messages are delivered as soon as its own check answers, so one follow's open wait never
        holds back another's."""
        with self._lock:
            if self._closed:
                return
            follows = list(self._follows)
        _parallel([lambda f=follow: self._check(f) for follow in follows])

    def _check(self, follow: Follow) -> None:
        """One follow's check: read what is new, save it, deliver what is due, then arrange the
        next one."""
        key = follow.server_id
        with self._lock:
            if self._closed or key in self._running or follow not in self._follows:
                return
            now = self._host.now()
            failures, resume_at = self._backoff.get(key, (0, 0.0))
            backoff = resume_at - now
            run = _Run(server_id=key, since=now)
            if backoff <= 0:
                self._running[key] = run
            wait = self._wait_for(now)
        if backoff > 0:
            # Asked before the backoff ended (a turn started, say): check once it does.
            self._schedule(key, backoff)
            return
        failed = False
        try:
            try:
                failed = not self._poll(follow, wait, run)
            except Exception:
                failed = True
            with self._lock:
                if not self._current(run):
                    return  # given up while it ran: the follow started again
                if failed:
                    failures += 1
                    limit = min(_BACKOFF_LIMIT_MILLIS, self._settings.poll_millis * 2**failures)
                    self._backoff[key] = (failures, now + limit)
                else:
                    self._backoff.pop(key, None)
                # A poll that ends after the session closed saves nothing: the saved checkpoint
                # stays before these messages, so a resumed session reads them again.
                if not self._closed:
                    self._persist()
        finally:
            with self._lock:
                if self._current(run):
                    del self._running[key]
        self.deliver()
        self._next(key, now, failed)

    def _current(self, run: _Run) -> bool:
        """Whether a check is still the one its follow runs: the follow did not start again."""
        return self._running.get(run.server_id) is run

    def _wait_for(self, now: float) -> int:
        """Seconds a poll that starts at ``now`` may wait on the server."""
        if not self._can_wait or self._settings.wait == "never":
            return 0
        # TalkTo allows a long wait only from a call that names its plugin.
        if self._can_report and now >= self._long_waits_from:
            return LONG_WAIT_SECONDS
        return WAIT_SECONDS

    def _step_down(self, now: float) -> None:
        """Polls wait ``WAIT_SECONDS`` from ``now``, and try a long wait again
        ``LONG_WAIT_RETRY_MILLIS`` later."""
        self._long_wait_failures = 0
        self._long_waits_from = now + LONG_WAIT_RETRY_MILLIS

    def _cut_short(self, words: str, run: _Run) -> bool:
        """Whether a long wait that failed with these words was cut short by Hermes or a proxy, so
        the same check is asked again at once with ``WAIT_SECONDS``, and polls step down. It was
        when it failed after ``CUT_MILLIS``, whatever it says, or in a host's or proxy's words, or
        when it is the ``LONG_WAIT_TRIES``th long wait in a row to fail. Otherwise the failure is
        handled as before (TalkTo unavailable, a brief network drop), and long waits go on."""
        with self._lock:
            if not self._current(run):
                return False
            self._long_wait_failures += 1
            now = self._host.now()
            cut = (
                now - run.since > CUT_MILLIS
                or _CUT_WORDS.search(words) is not None
                or self._long_wait_failures >= LONG_WAIT_TRIES
            )
            if cut:
                self._step_down(now)
            return cut

    def _next(self, key: str, started: float, failed: bool) -> None:
        """Arranges a follow's next check: once the backoff ends after a failure, a waiting poll
        right after this one, or a timed check when polls cannot wait. Nothing else would check an
        idle session again."""
        with self._lock:
            now = self._host.now()
            if failed:
                delay = self._backoff.get(key, (0, now))[1] - now
            elif self._wait_for(now) > 0:
                delay = REARM_MILLIS - (now - started)
            else:
                delay = float(self._settings.poll_millis)
        self._schedule(key, delay)

    def _schedule(self, key: str, delay: float) -> None:
        """Checks a follow after ``delay`` milliseconds; one such timer per follow at a time."""
        with self._lock:
            followed = any(item.server_id == key for item in self._follows)
            if self._closed or key in self._chained or not followed:
                return
            self._chained.add(key)

        def again() -> None:
            with self._lock:
                self._chained.discard(key)
                follow = next((item for item in self._follows if item.server_id == key), None)
            if follow is not None:
                self._check(follow)

        self._host.after(max(0.0, delay), again)

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

    def _page(self, follow: Follow, wait: int, run: _Run) -> Answer:
        args = {
            "serverId": follow.server_id,
            "participantId": follow.participant_id,
            "mode": "poll",
            "checkpoint": follow.checkpoint,
        }
        if wait <= WAIT_SECONDS:
            return self._updates(args, wait)
        # A long wait. TalkTo refusing it, and Hermes or a proxy cutting it short, end it the same
        # way: the check is asked again at once with the published wait, and polls step down for a
        # while. Nothing is lost: the checkpoint moves only with a page. Any other failure is
        # handled as before, and long waits go on.
        try:
            answer = self._read(
                {**args, "waitSeconds": wait, "plugin": release_text(PLUGIN_NAME, VERSION)}
            )
        except TransportError as cause:
            if not self._cut_short(str(cause), run):
                raise
            return self._updates(args, WAIT_SECONDS)
        reply = decode_updates(answer.envelope, "")
        failure = reply if isinstance(reply, UpdatesFailure) else None
        if failure is None or failure.code not in ("invalid_input", "unreadable"):
            # TalkTo answered the long wait: a page, or one of TalkTo's own failures.
            with self._lock:
                if self._current(run):
                    self._long_wait_failures = 0
            return answer
        if failure.code == "invalid_input":
            # TalkTo refused the long wait: a server from before long waits.
            with self._lock:
                if not self._current(run):
                    return answer
                self._step_down(self._host.now())
        elif not self._cut_short(failure.message, run):
            # Something answered in TalkTo's place, but not as a cut does.
            return answer
        return self._updates(args, WAIT_SECONDS)

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

    def _poll(self, follow: Follow, wait: int, run: _Run) -> bool:
        """Reads one follow's new messages into its queue; False on a failure worth retrying."""
        with self._lock:
            unchecked = follow.server_id in self._unchecked
        if unchecked:
            self._add_general(follow)
        pages = PAGES_PER_TICK
        page = 0
        while page < pages:
            try:
                # Only the first page waits; a continuation already has messages to read.
                answer = self._page(follow, wait if page == 0 else 0, run)
            except TransportError:
                return False
            reply = decode_updates(answer.envelope, follow.participant_id)
            if isinstance(reply, UpdatesFailure):
                return self._failed(follow, reply)
            with self._lock:
                if follow not in self._follows:
                    return True  # unfollowed or replaced while the call ran
                self._take_page(follow, reply)
                widened = None if reply.has_more else self._widening.pop(follow.server_id, None)
                if widened is not None:
                    # The old selection is read to the end: move to the one with General and read
                    # it at once, while what both returned is still queued, so it is queued once.
                    follow.checkpoint, follow.channel_ids = widened
                    pages = page + 2
            if not reply.has_more and widened is None:
                break
            page += 1
        return True

    def _add_general(self, follow: Follow) -> None:
        """A follow restored from a plugin before 0.3.1 may not watch General, where TalkTo
        announces new channels. TalkTo starts the selection with General added from now; the follow
        moves to it once its old checkpoint is read to the end, so nothing between the two is
        missed. A follow at the channel limit, or one TalkTo refuses the wider selection for, keeps
        the old selection."""
        with self._lock:
            self._unchecked.discard(follow.server_id)
        general = self._general_of(follow.server_id)
        if general is None or general in follow.channel_ids:
            return
        watched = watched_channels(follow.channel_ids, general)
        if watched.displaced is not None:
            return
        try:
            answer = self._updates(
                {
                    "serverId": follow.server_id,
                    "participantId": follow.participant_id,
                    "mode": "start",
                    "channelIds": list(watched.channel_ids),
                    "directChats": follow.direct_chats,
                    "startAt": "now",
                    "limit": 1,
                },
                0,
            )
        except TransportError:
            with self._lock:
                self._unchecked.add(follow.server_id)  # tried again at the next check
            return
        reply = decode_updates(answer.envelope, follow.participant_id)
        with self._lock:
            if isinstance(reply, UpdatesPage) and follow in self._follows:
                self._widening[follow.server_id] = (reply.checkpoint, watched.channel_ids)

    def _in_full(self, follow: Follow, conversation_id: str) -> bool:
        """Whether every message in a watched channel is delivered. A follow from before plugin
        0.3.5 delivers every channel but General, and General too while its ID is unknown."""
        if follow.full_channel_ids is not None:
            return conversation_id in follow.full_channel_ids
        return self._generals.get(follow.server_id) != conversation_id

    def _take(self, follow: Follow, messages: Sequence[IncomingMessage]) -> None:
        """Takes new messages: those that concern the participant into the queue, the rest of a
        channel's into its tally, starting the window when it was empty. Holds the lock."""
        known = {message.id for message in follow.pending}
        now = self._host.now()
        delivered: list[IncomingMessage] = []
        for message in messages:
            if message.id in known or message.id in self._counted:
                continue
            if message.scope != "channel" or self._in_full(follow, message.conversation_id):
                delivered.append(message)
                continue
            _tally(follow.quiet, message)
            if follow.quiet_since is None:
                follow.quiet_since = now
            self._counted[message.id] = None
            while len(self._counted) > _COUNTED_LIMIT:
                del self._counted[next(iter(self._counted))]
        _enqueue(follow.pending, delivered)
        self._arm_batch(now)

    # -- held channel messages ----------------------------------------------

    def _warm(self, at: float) -> bool:
        """Whether the prompt cache is still warm at ``at``: a turn ended within its lifetime."""
        return self._last_turn_at is not None and at < self._last_turn_at + self._settings.cache_millis

    def _flush_at(self, follow: Follow) -> Optional[float]:
        """When a follow's held messages go on their own: the window after the oldest, or just
        before the cache expires, whichever is first. None when none are held, and when the cache
        had nearly expired (or no turn end was seen) by the time the oldest arrived."""
        if follow.quiet_since is None or self._last_turn_at is None:
            return None
        cache = self._settings.cache_millis
        warm_until = self._last_turn_at + cache - cache_margin_of(cache)
        if follow.quiet_since >= warm_until:
            return None
        return min(follow.quiet_since + self._settings.channel_batch_millis, warm_until)

    def _batch_due(self, now: float) -> bool:
        """Whether some follow's held messages are due on their own now, while the cache is warm."""
        if not self._warm(now):
            return False
        for follow in self._follows:
            at = self._flush_at(follow)
            if at is not None and now >= at:
                return True
        return False

    def _arm_batch(self, now: float) -> None:
        """Tries delivery when the earliest held batch is due; one timer at a time. Holds the lock."""
        if self._batch_timer or self._closed or not self._warm(now):
            return
        due = [at for at in (self._flush_at(follow) for follow in self._follows) if at is not None]
        if not due:
            return
        self._batch_timer = True
        self._host.after(max(0.0, min(due) - now), self._batch_fired)

    def _batch_fired(self) -> None:
        with self._lock:
            self._batch_timer = False
        self.deliver()
        with self._lock:
            # A batch still due waits for the turn to end or the person; only a batch not yet due
            # needs this timer.
            later = self._host.now()
            if not self._batch_due(later):
                self._arm_batch(later)

    def _take_page(self, follow: Follow, page: UpdatesPage) -> None:
        self._take(follow, page.messages)
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

    def _cadence_wait(self, now: float, batch: bool = False) -> float:
        """How long the person's cadence still holds the next turn back: zero once any follow with
        queued messages (or held ones, when a ``batch`` is due) may wake, else the shortest wait."""
        waits = [
            max(0.0, self._last_wake_at + self._cadence.get(item.server_id, 0) - now)
            for item in self._follows
            if item.pending or item.dropped or (batch and item.quiet_since is not None)
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
        if failure.code == _REMOVED:
            name = self._name_of_server(follow.server_id)
            with self._lock:
                self._follows = [item for item in self._follows if item is not follow]
                self._notes.append(participant_removed(follow, name))
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
            batch = self._batch_due(now)
            text = self._notice_text(frozenset(), renames_alone=False, update=update, batch=batch)
            if text is None:
                return
            held = 0.0 if has_urgent or self._notes else self._cadence_wait(now, batch)
            if held > 0:
                # Urgent messages and plugin notes ignore the cadence; the rest wait for it.
                if not self._cadence_timer:
                    self._cadence_timer = True
                    self._host.after(held, self._cadence_due)
                return
            snapshot = self._snapshot(now, now if update else None)
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
        text = self._notice_text(
            held, renames_alone=True, update=update, batch=self._batch_due(now)
        )
        if text is None:
            return None
        snapshot = self._snapshot(now, now if update else None)
        # A held summary the submitted notice carries is not shown here, so it is not cleared here.
        recent = frozenset(h.id for f in self._follows for t in f.quiet for h in t.recent)
        self._clear_delivered(
            replace(snapshot, ids=snapshot.ids - held - recent, tallies={})
            if held
            else snapshot
        )
        self._arm_batch(now)
        self._persist()
        return text

    def _notice_text(
        self,
        without: frozenset[str],
        renames_alone: bool,
        update: bool = False,
        batch: bool = False,
    ) -> Optional[str]:
        """The combined notice for everything queued except ``without``, or None. Queued renames go
        with any notice; on their own they make one only when ``renames_alone`` (the person's
        prompt carries it). Held channel messages go with any notice as a short summary; on their
        own they make one only when a ``batch`` is due. A summary a submitted notice carries
        (``without`` is not empty) is not repeated."""
        parts = list(self._notes)
        waking = bool(parts)
        for follow in self._follows:
            messages = [m for m in follow.pending if m.id not in without]
            renames = [r for r in follow.renames if r.id not in without]
            waking = waking or bool(messages) or follow.dropped > 0
            if messages or follow.dropped > 0 or renames:
                parts.append(queued_notice(follow, messages, follow.dropped, renames))
        if not waking and not batch and not (renames_alone and parts):
            return None
        alone = not parts
        summaries = (
            []
            if without
            else [
                held_summary(follow, follow.quiet, alone) for follow in self._follows if follow.quiet
            ]
        )
        if alone and not summaries:
            return None
        sections = [] if alone else ["\n\n---\n\n".join(parts)]
        if summaries:
            sections.append(("\n\n---\n\n" if alone else "\n\n").join(summaries))
        if update:
            sections.append(update_notice(PLUGIN_NAME, VERSION, self._latest_version or ""))
        return "\n\n".join(sections)

    def _snapshot(self, at: float, update_at: Optional[float] = None) -> _Snapshot:
        return _Snapshot(
            update_at=update_at,
            notes=len(self._notes),
            ids=frozenset(
                [m.id for follow in self._follows for m in follow.pending]
                + [r.id for follow in self._follows for r in follow.renames]
                + [h.id for follow in self._follows for t in follow.quiet for h in t.recent]
            ),
            tallies={
                _tally_key(follow.server_id, tally.conversation_id): tally.count
                for follow in self._follows
                for tally in follow.quiet
            },
            at=at,
        )

    def _clear_delivered(self, snapshot: _Snapshot) -> None:
        if snapshot.update_at is not None:
            self._update_notice_at = snapshot.update_at
        self._notes = self._notes[snapshot.notes :]
        for follow in self._follows:
            follow.pending = [m for m in follow.pending if m.id not in snapshot.ids]
            follow.renames = [r for r in follow.renames if r.id not in snapshot.ids]
            follow.dropped = 0
            # A summary shown starts again; what was held while the notice went out stays, in a
            # new window from when the notice was taken.
            shown = False
            kept: list[Tally] = []
            for tally in follow.quiet:
                key = _tally_key(follow.server_id, tally.conversation_id)
                if key in snapshot.tallies:
                    shown = True
                count = tally.count - snapshot.tallies.get(key, 0)
                if count > 0:
                    recent = tuple(h for h in tally.recent if h.id not in snapshot.ids)
                    kept.append(replace(tally, count=count, recent=recent))
            follow.quiet = kept
            if not kept:
                follow.quiet_since = None
            elif shown:
                follow.quiet_since = snapshot.at

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


#: Words of a host or proxy ending a call it held too long, whenever it does: a timeout, an abort,
#: or a gateway that answered in TalkTo's place.
_CUT_WORDS = re.compile(r"timed? ?out|timeout|abort|gateway|\b(?:408|502|504|524)\b", re.I)


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


def _parallel(runs: Sequence[Callable[[], None]]) -> None:
    """Runs each follow's check on its own thread, since each may wait up to 50 seconds on
    TalkTo, and returns once all have ended."""

    def run(index: int) -> None:
        try:
            runs[index]()
        except Exception:
            pass

    if len(runs) == 1:
        run(0)
        return
    threads = [
        threading.Thread(target=run, args=(index,), daemon=True, name="talkto-poll")
        for index in range(len(runs))
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
