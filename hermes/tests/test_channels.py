"""Which channel messages wake the session, and how the rest are held and summarized: a port of
core/tests/channels.spec.mjs for the Hermes inbox."""

from __future__ import annotations

import unittest

from support import DIRECT, GENERAL, ME, SERVER, FakeHost, envelope, load, message

plugin = load()
inbox_module = plugin.inbox
Inbox, Settings = inbox_module.Inbox, inbox_module.Settings
SETTLE = inbox_module.SETTLE_MILLIS
MINUTE = 60_000
#: Hermes's defaults: a five-minute cache, so a held batch goes four minutes after the last turn.
DEADLINE = 5 * MINUTE - inbox_module.cache_margin_of(5 * MINUTE)


def following(host: FakeHost, settings=None, **given) -> "Inbox":
    """A follow made in a turn that ends at time 0, so the cache is warm from then."""
    inbox = Inbox(host, settings or Settings(wait="never"))
    host.answers.append(envelope([]))
    inbox.on_turn_start("follow", "follow TalkTo")
    answer = inbox.follow(
        inbox_module.read_follow_input({"serverId": SERVER, "participantId": ME, **given})
    )
    assert answer.startswith("Following participant"), answer
    inbox.on_turn_complete("follow")
    host.clock.time = SETTLE * 10
    host.clock.timers.clear()
    return inbox


def checked(host: FakeHost, inbox: "Inbox", messages: list) -> None:
    """One check, then the settle time, so whatever is due is submitted."""
    host.answers.append(envelope(messages))
    inbox.tick()
    host.clock.advance(SETTLE)


def advance_to(host: FakeHost, at: float) -> None:
    """Moves time to ``at`` a minute at a time, so timers set on the way run too."""
    while host.clock.time + MINUTE < at:
        host.clock.advance(MINUTE)
    host.clock.advance(at - host.clock.time)


def follow_of(host: FakeHost) -> dict:
    return host.stored["follows"][0]


class ChannelTest(unittest.TestCase):
    def test_a_general_message_without_a_mention_starts_no_turn_and_is_held(self) -> None:
        host = FakeHost()
        inbox = following(host)
        one, two = message(body="chatter one"), message(body="chatter two\nmore"),
        checked(host, inbox, [one, two])
        self.assertEqual(host.submitted, [])
        saved = follow_of(host)
        self.assertEqual(saved["pending"], [])
        self.assertEqual(
            saved["quiet"],
            [
                {
                    "conversation_id": GENERAL,
                    "where": "#general",
                    "count": 2,
                    "senders": ["planner"],
                    "recent": [
                        {"id": one["id"], "from": "planner", "line": "chatter one"},
                        {"id": two["id"], "from": "planner", "line": "chatter two"},
                    ],
                }
            ],
        )
        self.assertEqual(saved["quiet_since"], SETTLE * 10)
        self.assertIn("2 channel messages held for a summary", inbox.describe())
        # A page read again is not held again, and what is held survives a reload.
        checked(host, inbox, [one])
        self.assertEqual(follow_of(host)["quiet"][0]["count"], 2)
        reloaded = Inbox(host, Settings(wait="never"))
        reloaded.restore()
        self.assertIn("2 channel messages held for a summary", reloaded.describe())

    def test_a_held_batch_goes_just_before_the_cache_expires(self) -> None:
        host = FakeHost()
        inbox = following(host)
        host.clock.time = 2 * MINUTE
        chatter = message(body="chatter")
        checked(host, inbox, [chatter])
        # The window would end at 6 minutes; the five-minute cache needs it by 4.
        advance_to(host, DEADLINE - 1)
        self.assertEqual(host.submitted, [])
        advance_to(host, DEADLINE + SETTLE)
        self.assertEqual(len(host.submitted), 1)
        self.assertTrue(
            host.submitted[0].startswith(
                f"TalkTo: 1 channel message for your participant {ME} on server {SERVER}"
            ),
            host.submitted[0],
        )
        self.assertIn(f"- planner: chatter · messageId {chatter['id']}", host.submitted[0])
        inbox.on_turn_start("batch", host.submitted[0])
        self.assertEqual(follow_of(host)["quiet"], [])
        self.assertIsNone(follow_of(host)["quiet_since"])

    def test_when_the_window_ends_first_the_batch_goes_then(self) -> None:
        host = FakeHost()
        settings = Settings(wait="never", cache_millis=60 * MINUTE, channel_batch_millis=4 * MINUTE)
        inbox = following(host, settings)
        checked(host, inbox, [message(body="chatter")])
        start = SETTLE * 10
        advance_to(host, start + 4 * MINUTE - 1)
        self.assertEqual(host.submitted, [])
        advance_to(host, start + 4 * MINUTE + SETTLE)
        self.assertEqual(len(host.submitted), 1)

    def test_a_session_whose_cache_expired_is_not_woken(self) -> None:
        host = FakeHost()
        inbox = following(host)
        host.clock.time = DEADLINE + MINUTE
        checked(host, inbox, [message(body="late chatter")])
        advance_to(host, 3 * 60 * MINUTE)
        self.assertEqual(host.submitted, [], "no cold wake, however long it waits")
        checked(host, inbox, [message(conversationId=DIRECT, body="a direct question")])
        self.assertEqual(len(host.submitted), 1)
        self.assertIn("a direct question", host.submitted[0])
        self.assertIn("Also, 1 channel message that did not @mention you", host.submitted[0])
        self.assertIn("- planner: late chatter · messageId", host.submitted[0])

    def test_a_real_wake_takes_the_held_messages_along_and_the_window_starts_again(self) -> None:
        host = FakeHost()
        settings = Settings(wait="never", cache_millis=60 * MINUTE, channel_batch_millis=4 * MINUTE)
        inbox = following(host, settings)
        checked(host, inbox, [message(body="chatter")])
        host.clock.advance(MINUTE)
        checked(host, inbox, [message(conversationId=DIRECT, body="a direct question")])
        self.assertEqual(len(host.submitted), 1)
        self.assertTrue(host.submitted[0].startswith("TalkTo: 1 new message for your participant"))
        self.assertIn("- planner: chatter · messageId", host.submitted[0])
        inbox.on_turn_start("notice", host.submitted[0])
        self.assertEqual(follow_of(host)["quiet"], [], "shown once, then cleared")
        inbox.on_turn_complete("notice")
        host.clock.advance(MINUTE)
        later = host.clock.time
        checked(host, inbox, [message(body="more chatter")])
        self.assertEqual(follow_of(host)["quiet_since"], later)
        advance_to(host, later + 4 * MINUTE - 1)
        self.assertEqual(len(host.submitted), 1)
        advance_to(host, later + 4 * MINUTE + SETTLE)
        self.assertEqual(len(host.submitted), 2)
        self.assertNotIn("a direct question", host.submitted[1])

    def test_mentions_direct_chats_notices_and_full_channels_are_delivered(self) -> None:
        host = FakeHost()
        inbox = following(host)
        checked(host, inbox, [message(body="for me", mentions=[ME])])
        self.assertEqual(len(host.submitted), 1)
        self.assertIn("for me", host.submitted[0])
        full = FakeHost()
        inbox = following(full, fullChannelIds=[GENERAL])
        checked(full, inbox, [message(body="all of it")])
        self.assertEqual(len(full.submitted), 1)
        self.assertIn("all of it", full.submitted[0])
        announced = FakeHost()
        inbox = following(announced)
        checked(
            announced,
            inbox,
            [
                message(
                    body="TalkTo: planner created the channel #deploys.\nTo follow it, add it.",
                    notice={"kind": "channel_created", "channelId": DIRECT, "channelName": "x"},
                )
            ],
        )
        self.assertIn(
            "TalkTo notice in #general: TalkTo: planner created the channel #deploys. To follow it",
            announced.submitted[0],
        )

    def test_settings_in_minutes(self) -> None:
        self.assertEqual(inbox_module.minutes_setting(None), None)
        self.assertEqual(inbox_module.minutes_setting(""), None)
        self.assertEqual(inbox_module.minutes_setting("ten"), None)
        self.assertEqual(inbox_module.minutes_setting(True), None)
        self.assertEqual(inbox_module.minutes_setting("10"), 10 * MINUTE)
        self.assertEqual(inbox_module.minutes_setting(0), MINUTE)
        self.assertEqual(inbox_module.minutes_setting(10**6), 24 * 60 * MINUTE)


if __name__ == "__main__":
    unittest.main()
