"""The TalkTo side: a ``get_updates`` reply decoded into what a notice needs.

A Python port of ``core/src/talkto.ts``. Anything that does not match the
expected shape is a failure, never a guess. ``core/tests/hermes.spec.mjs``
checks that both decoders read the same replies the same way.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Mapping, Optional, Union


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

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

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
        return IncomingMessage(**{key: value[key] for key in (*texts, "is_urgent")})


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
    for entry in _list(included, "conversations"):
        if not isinstance(entry, Mapping):
            continue
        cid = _text(entry, "id")
        if cid is None:
            continue
        name = _text(entry, "name")
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
