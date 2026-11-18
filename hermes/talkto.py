"""The TalkTo side: a ``get_updates`` reply decoded into what a notice needs.

A Python port of ``core/src/talkto.ts``. Anything that does not match the
expected shape is a failure, never a guess. ``core/tests/hermes.spec.mjs``
checks that both decoders read the same replies the same way.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Optional, Union


_SHA256 = re.compile(r"[0-9a-f]{64}")


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2**53 - 1


@dataclass(frozen=True)
class FileOffer:
    """A file or folder a message offers. The receiver fetches it with fetch_transfer, by ``id``."""

    id: str
    #: The sender's name for it: untrusted display text.
    name: str
    #: "file" or "folder".
    kind: str
    bytes: int
    sha256: str
    #: How many files a folder holds; None for a file.
    file_count: Optional[int]
    expires_at: str

    @staticmethod
    def read(fields: Mapping[str, Any], camel: bool) -> Optional["FileOffer"]:
        """An offer from ``get_updates`` (camelCase) or from saved state, or None when a field is
        missing or malformed."""
        file_count = fields.get("fileCount" if camel else "file_count")
        expires_at = fields.get("expiresAt" if camel else "expires_at")
        texts = [fields.get(key) for key in ("id", "name", "kind", "sha256")]
        if not all(isinstance(value, str) for value in [*texts, expires_at]):
            return None
        oid, name, kind, sha256 = texts
        if kind not in ("file", "folder") or not _SHA256.fullmatch(str(sha256)):
            return None
        if not _is_count(fields.get("bytes")) or not (file_count is None or _is_count(file_count)):
            return None
        return FileOffer(
            id=str(oid),
            name=str(name),
            kind=str(kind),
            bytes=int(fields["bytes"]),
            sha256=str(sha256),
            file_count=file_count,
            expires_at=str(expires_at),
        )


#: Why a message reached this participant, which decides whether it wakes the session: one of its
#: direct chats, a channel message that @mentions it, a notice TalkTo wrote (such as a new channel),
#: or any other message in a channel it watches.
SCOPES = ("direct", "mention", "notice", "channel")


@dataclass(frozen=True)
class IncomingMessage:
    """One incoming message, as much as a notice shows."""

    id: str
    conversation_id: str
    sender_id: str
    created_at: str
    body: str
    is_urgent: bool
    #: "#general" or "direct chat with planner".
    where: str
    #: "planner (codex)", or the sender ID when the reply did not describe it.
    sender: str
    #: The file or folder the message offers; None when it offers none.
    transfer: Optional[FileOffer] = None
    #: True when the plugin's queue kept only the start of the body.
    cut: bool = False
    #: Why it reached this participant (one of ``SCOPES``). None when the reply did not describe its
    #: conversation, and in a message queued before plugin 0.3.5; such a message is delivered in full.
    scope: Optional[str] = None

    def to_json(self) -> dict[str, Any]:
        saved = asdict(self)
        if self.transfer is None:
            del saved["transfer"]
        if not self.cut:
            del saved["cut"]
        if self.scope is None:
            del saved["scope"]
        return saved

    @staticmethod
    def from_json(value: object) -> Optional["IncomingMessage"]:
        """A message this plugin saved, or None when the value is not one."""
        if not isinstance(value, Mapping):
            return None
        texts = (
            "id",
            "conversation_id",
            "sender_id",
            "created_at",
            "body",
            "where",
            "sender",
        )
        if not all(isinstance(value.get(key), str) for key in texts):
            return None
        if not isinstance(value.get("is_urgent"), bool):
            return None
        # Absent in a message saved before offers were kept, and in one that offers nothing.
        saved = value.get("transfer")
        transfer = None
        if saved is not None:
            transfer = FileOffer.read(saved, camel=False) if isinstance(saved, Mapping) else None
            if transfer is None:
                return None
        # Absent for a whole body, and in a message saved before the queue marked cut bodies.
        cut = value.get("cut", False)
        if not isinstance(cut, bool):
            return None
        # Absent in a message queued before plugin 0.3.5, or whose conversation was not described.
        scope = value.get("scope")
        if scope is not None and scope not in SCOPES:
            return None
        return IncomingMessage(
            **{key: value[key] for key in (*texts, "is_urgent")},
            transfer=transfer,
            cut=cut,
            scope=scope,
        )


@dataclass(frozen=True)
class ParticipantRename:
    """One participant's name change. The participant keeps its ID; only its name changed."""

    id: str
    participant_id: str
    previous_name: str
    name: str
    #: "self" (an agent operation for that participant), "person", or None when the server
    #: named nobody this plugin understands.
    by_kind: Optional[str]
    #: The person's name when ``by_kind`` is "person", else None.
    by_name: Optional[str]

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_json(value: object) -> Optional["ParticipantRename"]:
        """A rename this plugin saved, or None when the value is not one."""
        if not isinstance(value, Mapping):
            return None
        texts = ("id", "participant_id", "previous_name", "name")
        if not all(isinstance(value.get(key), str) for key in texts):
            return None
        by_kind, by_name = value.get("by_kind"), value.get("by_name")
        if not (
            (by_kind is None and by_name is None)
            or (by_kind == "self" and by_name is None)
            or (by_kind == "person" and isinstance(by_name, str))
        ):
            return None
        return ParticipantRename(
            **{key: value[key] for key in texts}, by_kind=by_kind, by_name=by_name
        )


@dataclass(frozen=True)
class UpdatesPage:
    messages: tuple[IncomingMessage, ...]
    checkpoint: str
    has_more: bool
    #: The person's wake cadence: start an idle turn for normal messages at most this often.
    #: None from a server that does not send it, which keeps the old behavior.
    wake_interval_seconds: Optional[int] = None
    #: Renames since the checkpoint; empty from a server that does not send them.
    renames: tuple[ParticipantRename, ...] = ()
    #: The newest published version of this plugin, as in "0.3.0", when the call named the plugin
    #: and the server knows it. None from a server that does not send it.
    latest_plugin_version: Optional[str] = None


@dataclass(frozen=True)
class UpdatesFailure:
    """TalkTo's error code and message, or a local code such as ``unreadable``."""

    code: str
    message: str


UpdatesReply = Union[UpdatesPage, UpdatesFailure]


def _text(fields: Mapping[str, Any], key: str) -> Optional[str]:
    value = fields.get(key)
    return value if isinstance(value, str) else None


def _fields(fields: Mapping[str, Any], key: str) -> Optional[Mapping[str, Any]]:
    value = fields.get(key)
    return value if isinstance(value, Mapping) else None


def _list(fields: Mapping[str, Any], key: str) -> list[Any]:
    value = fields.get(key)
    return value if isinstance(value, list) else []


_AGENT_TYPE = re.compile(r" \(.*\)$")
#: A plugin version: three numbers, as in "0.3.0".
VERSION_PATTERN = re.compile(r"\d{1,4}\.\d{1,4}\.\d{1,4}")
_MESSAGE_FIELDS = ("id", "conversationId", "senderId", "createdAt", "body")


def _renames(data: Mapping[str, Any]) -> tuple[ParticipantRename, ...]:
    """The page's renames, read leniently: the field is additive, so an entry this plugin cannot
    read is skipped rather than failing the page and its messages."""
    renames: list[ParticipantRename] = []
    for entry in _list(data, "renames"):
        if not isinstance(entry, Mapping):
            continue
        rid, participant_id = _text(entry, "id"), _text(entry, "participantId")
        previous_name, name = _text(entry, "previousName"), _text(entry, "name")
        if rid is None or participant_id is None or previous_name is None or name is None:
            continue
        actor = _fields(entry, "renamedBy")
        kind = None if actor is None else _text(actor, "kind")
        person = None if actor is None else _text(actor, "name")
        by_kind: Optional[str] = None
        by_name: Optional[str] = None
        if kind == "self":
            by_kind = "self"
        elif kind == "person" and person is not None:
            by_kind, by_name = "person", person
        renames.append(
            ParticipantRename(
                id=rid,
                participant_id=participant_id,
                previous_name=previous_name,
                name=name,
                by_kind=by_kind,
                by_name=by_name,
            )
        )
    return tuple(renames)


def _scope(entry: Mapping[str, Any], channel: Optional[bool], participant_id: str) -> Optional[str]:
    """Why a message reached ``participant_id``: TalkTo's own ``notice``, its direct chat, an
    @mention in ``mentions``, or a channel it watches. None when the conversation was not described."""
    if isinstance(entry.get("notice"), (Mapping, list)):
        return "notice"
    if channel is None:
        return None
    if not channel:
        return "direct"
    return "mention" if participant_id in _list(entry, "mentions") else "channel"


def decode_updates(envelope: object, participant_id: str) -> UpdatesReply:
    """Decode one ``get_updates`` reply envelope for ``participant_id``."""
    if not isinstance(envelope, Mapping):
        return UpdatesFailure("unreadable", "TalkTo answered with no readable result.")
    error = _fields(envelope, "error")
    if error is not None:
        return UpdatesFailure(
            _text(error, "code") or "unknown",
            _text(error, "message") or "TalkTo reported an error.",
        )
    data = _fields(envelope, "data")
    checkpoint = None if data is None else _text(data, "checkpoint")
    if data is None or checkpoint is None:
        return UpdatesFailure("unreadable", "TalkTo answered without a checkpoint.")
    included = _fields(envelope, "included") or {}
    names: dict[str, str] = {}
    for entry in _list(included, "participants"):
        if not isinstance(entry, Mapping):
            continue
        pid, name, kind = _text(entry, "id"), _text(entry, "name"), _text(entry, "agentType")
        if pid is not None and name is not None:
            names[pid] = name if kind is None else f"{name} ({kind})"
    places: dict[str, str] = {}
    #: Whether each described conversation is a channel (True) or a direct chat (False).
    channels: dict[str, bool] = {}
    for entry in _list(included, "conversations"):
        if not isinstance(entry, Mapping):
            continue
        cid = _text(entry, "id")
        if cid is None:
            continue
        name = _text(entry, "name")
        kind = _text(entry, "kind")
        # A record without a kind: a channel has a name, a direct chat has none.
        channels[cid] = kind == "channel" or (kind != "direct" and name is not None)
        if name is not None:
            places[cid] = f"#{name}"
            continue
        other = next(
            (
                member
                for member in _list(entry, "participantIds")
                if isinstance(member, str) and member != participant_id
            ),
            None,
        )
        other_name = None if other is None else names.get(other)
        if other_name is not None:
            other_name = _AGENT_TYPE.sub("", other_name)
        places[cid] = "a direct chat" if other_name is None else f"direct chat with {other_name}"
    messages: list[IncomingMessage] = []
    for entry in _list(data, "messages"):
        if not isinstance(entry, Mapping):
            return UpdatesFailure("unreadable", "TalkTo answered with an unreadable message.")
        found = [_text(entry, key) for key in _MESSAGE_FIELDS]
        values = [value for value in found if value is not None]
        if len(values) != len(_MESSAGE_FIELDS):
            return UpdatesFailure("unreadable", "TalkTo answered with an incomplete message.")
        mid, conversation_id, sender_id, created_at, body = values
        # The offer is additive: one this plugin cannot read is left out, never failing the message.
        offered = _fields(entry, "transfer")
        messages.append(
            IncomingMessage(
                id=mid,
                conversation_id=conversation_id,
                sender_id=sender_id,
                created_at=created_at,
                body=body,
                is_urgent=_text(entry, "priority") == "urgent",
                where=places.get(conversation_id, f"conversation {conversation_id}"),
                sender=names.get(sender_id, f"participant {sender_id}"),
                transfer=None if offered is None else FileOffer.read(offered, camel=True),
                scope=_scope(entry, channels.get(conversation_id), participant_id),
            )
        )
    interval = data.get("wakeIntervalSeconds")
    latest = _text(data, "latestPluginVersion")
    return UpdatesPage(
        messages=tuple(messages),
        checkpoint=checkpoint,
        has_more=_text(data, "nextCursor") is not None,
        wake_interval_seconds=(
            interval
            if isinstance(interval, int)
            and not isinstance(interval, bool)
            and 0 <= interval <= 86_400
            else None
        ),
        renames=_renames(data),
        latest_plugin_version=(
            latest if latest is not None and VERSION_PATTERN.fullmatch(latest) else None
        ),
    )


def server_name_of(envelope: object) -> Optional[str]:
    """The server's name from a ``get_context`` reply envelope (``data.server.name``), or None."""
    if not isinstance(envelope, Mapping) or _fields(envelope, "error") is not None:
        return None
    data = _fields(envelope, "data")
    server = None if data is None else _fields(data, "server")
    return None if server is None else _text(server, "name")


def general_id_of(envelope: object) -> Optional[str]:
    """The server's General channel from a ``get_context`` reply envelope
    (``data.server.generalConversationId``), or None for an error or any reply that does not name it."""
    if not isinstance(envelope, Mapping) or _fields(envelope, "error") is not None:
        return None
    data = _fields(envelope, "data")
    server = None if data is None else _fields(data, "server")
    return None if server is None else _text(server, "generalConversationId")
