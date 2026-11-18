"""Reads TalkTo replies as JSON on stdin and prints what the Python port makes
of them, for core/tests/hermes.spec.mjs to compare with the TypeScript core."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from support import load  # noqa: E402

plugin = load()
decode_updates = plugin.talkto.decode_updates
UpdatesFailure = plugin.talkto.UpdatesFailure
notice = plugin.notice


class Recipient:
    def __init__(self, server_id: str, participant_id: str) -> None:
        self.server_id = server_id
        self.participant_id = participant_id


def camel(message) -> dict:
    fields = {
        "id": message.id,
        "conversationId": message.conversation_id,
        "senderId": message.sender_id,
        "createdAt": message.created_at,
        "body": message.body,
        "isUrgent": message.is_urgent,
        "where": message.where,
        "from": message.sender,
    }
    if message.scope is not None:
        fields["scope"] = message.scope
    offer = message.transfer
    if offer is not None:
        fields["transfer"] = {
            "id": offer.id,
            "name": offer.name,
            "kind": offer.kind,
            "bytes": offer.bytes,
            "sha256": offer.sha256,
            "fileCount": offer.file_count,
            "expiresAt": offer.expires_at,
        }
    return fields


def camel_rename(rename) -> dict:
    by = None
    if rename.by_kind == "self":
        by = {"kind": "self"}
    elif rename.by_kind == "person":
        by = {"kind": "person", "name": rename.by_name}
    return {
        "id": rename.id,
        "participantId": rename.participant_id,
        "previousName": rename.previous_name,
        "name": rename.name,
        "by": by,
    }


def run(case: dict) -> dict:
    reply = decode_updates(case["envelope"], case["participantId"])
    if isinstance(reply, UpdatesFailure):
        return {"failure": {"code": reply.code, "message": reply.message}}
    recipient = Recipient(case["serverId"], case["participantId"])
    messages = list(reply.messages)
    return {
        "page": {
            "messages": [camel(message) for message in messages],
            "renames": [camel_rename(rename) for rename in reply.renames],
            "checkpoint": reply.checkpoint,
            "hasMore": reply.has_more,
            "wakeIntervalSeconds": reply.wake_interval_seconds,
            "latestPluginVersion": reply.latest_plugin_version,
        },
        "queued": notice.queued_notice(recipient, messages, case["dropped"], reply.renames),
        "urgent": notice.urgent_notice(recipient, messages),
        "ended": notice.follow_ended(recipient, "participant_not_found: gone"),
    }


def update(case: dict) -> dict:
    return {
        "text": notice.update_notice(case["name"], case["version"], case["latest"]),
        "newer": notice.is_newer(case["latest"], case["version"]),
    }


def held(case: dict) -> dict:
    """A held summary, previews and the follow answer's wake rules, for the core to compare."""
    tallies = [
        notice.Tally(
            tally["conversationId"],
            tally["where"],
            tally["count"],
            tuple(tally["senders"]),
            tuple(notice.HeldMessage(h["id"], h["from"], h["line"]) for h in tally["recent"]),
        )
        for tally in case["tallies"]
    ]
    recipient = Recipient(case["serverId"], case["participantId"])
    return {
        "summary": notice.held_summary(recipient, tallies, case["alone"]),
        "previews": [notice.preview_of(body) for body in case["bodies"]],
        "rules": plugin.inbox.wake_rules(case["full"], case["generalInFull"], case["batchMillis"]),
    }


def tools() -> dict:
    return {
        "description": plugin.tools.follow_description("this Hermes session"),
        "schema": plugin.tools.FOLLOW_PARAMETERS,
        "timing": {
            "cacheMinutes": plugin.inbox.DEFAULT_CACHE_MINUTES,
            "batchMinutes": plugin.inbox.DEFAULT_BATCH_MINUTES,
        },
    }


cases = json.load(sys.stdin)
if "--updates" in sys.argv:
    json.dump([update(case) for case in cases], sys.stdout, ensure_ascii=False)
elif "--held" in sys.argv:
    json.dump([held(case) for case in cases], sys.stdout, ensure_ascii=False)
elif "--tools" in sys.argv:
    json.dump(tools(), sys.stdout, ensure_ascii=False)
else:
    json.dump([run(case) for case in cases], sys.stdout, ensure_ascii=False)
