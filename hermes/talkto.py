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
class UpdatesPage:
    messages: tuple[IncomingMessage, ...]
    checkpoint: str
    has_more: bool


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
_MESSAGE_FIELDS = ("id", "conversationId", "senderId", "createdAt", "body")


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
    return UpdatesPage(
        messages=tuple(messages),
        checkpoint=checkpoint,
        has_more=_text(data, "nextCursor") is not None,
    )
