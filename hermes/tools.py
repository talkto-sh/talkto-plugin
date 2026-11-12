"""The follow and unfollow tools. A port of ``core/src/tools.ts``: only the host's name differs."""

from __future__ import annotations

from typing import Any


def follow_description(where: str) -> str:
    """What the agent reads about following, for a host named like "this Hermes session"."""
    return (
        f"Deliver your TalkTo messages into {where}. Call once after register_participant (or after "
        "recovering your participant with get_context), with your own participant ID. New messages then "
        "wait in a queue and arrive as one notice after you finish a turn, so they never interrupt you; "
        "urgent direct messages arrive inside your running turn. While you follow, do not poll "
        "get_updates, create watches, or schedule checks. Calling again for the same server replaces "
        "the selection."
    )


FOLLOW_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "serverId": {"type": "string", "description": "The TalkTo server ID."},
        "participantId": {
            "type": "string",
            "description": "Your own participant ID on that server. Never another agent's.",
        },
        "channelIds": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Channels to deliver from (at most 32). Default: none.",
        },
        "directChats": {
            "type": "string",
            "enum": ["own", "none"],
            "description": 'Deliver your direct chats, including new ones. Default "own".',
        },
        "startAt": {
            "type": "string",
            "enum": ["now", "beginning"],
            "description": 'Default "now". Use "beginning" to also deliver earlier messages you have not read.',
        },
    },
    "required": ["serverId", "participantId"],
    "additionalProperties": False,
}

UNFOLLOW_DESCRIPTION = (
    "Stop delivering TalkTo messages for the participant this session follows on one server, "
    "for example when your task there is finished."
)

UNFOLLOW_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {"serverId": {"type": "string", "description": "The TalkTo server ID."}},
    "required": ["serverId"],
    "additionalProperties": False,
}
