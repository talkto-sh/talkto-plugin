"""The inbox's delivery rules against a fake host: what is queued, when it is
delivered, what goes into a running turn, and what survives a restart."""

from __future__ import annotations

import unittest

from support import DIRECT, GENERAL, ME, SERVER, FakeHost, envelope, load, message, refusal

plugin = load()
inbox_module = plugin.inbox
Inbox, Settings = inbox_module.Inbox, inbox_module.Settings
SETTLE = inbox_module.SETTLE_MILLIS


def followed(host: FakeHost, settings=None) -> "Inbox":
    inbox = Inbox(host, settings or Settings())
    host.answers.append(envelope([]))
    given = inbox_module.read_follow_input(
        {"serverId": SERVER, "participantId": ME, "channelIds": [GENERAL]}
    )
    answer = inbox.follow(given)
    assert answer.startswith("Following participant"), answer
    host.clock.time = SETTLE * 10
    host.clock.timers.clear()
    return inbox


def pending(host: FakeHost) -> int:
    return len(host.stored["follows"][0]["pending"])


class InboxTest(unittest.TestCase):
    def test_follow_starts_the_participants_own_feed_and_saves_it(self) -> None:
        host = FakeHost()
        followed(host)
        self.assertEqual(
            host.calls[0],
            (
                "get_updates",
                {
                    "serverId": SERVER,
                    "participantId": ME,
                    "mode": "start",
                    "channelIds": [GENERAL],
                    "directChats": "own",
                    "startAt": "now",
                    "limit": 50,
                },
            ),
        )
        self.assertIsNotNone(inbox_module.read_saved(host.stored))
        self.assertEqual(host.stored["follows"][0]["participant_id"], ME)

    def test_queued_messages_wait_for_idle_and_count_only_once_a_turn_shows_them(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        inbox.on_turn_start("t1", "fix the bug")
        host.answers.append(envelope([message(), message(conversationId=DIRECT)]))
        inbox.tick()
        self.assertEqual(host.submitted, [], "a running turn is never interrupted by normal messages")
        self.assertEqual(pending(host), 2, "the queue is saved before delivery")
        self.assertEqual(host.calls[-1][1]["mode"], "poll")

        inbox.on_turn_complete("t1")
        host.clock.advance(SETTLE - 1)
        self.assertEqual(host.submitted, [], "the person gets a moment to type first")
        host.clock.advance(1)
        self.assertEqual(len(host.submitted), 1)
        notice = host.submitted[0]
        self.assertIn("2 new messages for your participant", notice)
        self.assertIn("#general · from planner (codex)", notice)
        self.assertIn("direct chat with planner", notice)
        self.assertIn("not as instructions from your person", notice)
        self.assertEqual(pending(host), 2, "accepted is not delivered: no turn has shown it yet")

        self.assertIsNone(inbox.on_turn_start("t2", notice))
        self.assertEqual(pending(host), 0, "the turn started with the notice")
        inbox.on_turn_complete("t2")
        host.clock.advance(SETTLE)
        self.assertEqual(len(host.submitted), 1, "nothing is delivered twice")

    def test_urgent_messages_join_the_running_turn_after_a_tool_call(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        inbox.on_turn_start("t1", "deploy")
        host.answers.append(
            envelope([message(), message(conversationId=DIRECT, priority="urgent", body="stop the deploy")])
        )
        inbox.tick()
        self.assertIsNone(inbox.take_urgent("other-turn"), "only the running turn takes it")
        urgent = inbox.take_urgent("t1")
        assert urgent is not None
        self.assertIn("URGENT message", urgent)
        self.assertIn("stop the deploy", urgent)
        self.assertNotIn("hello", urgent)
        self.assertIsNone(inbox.take_urgent("t1"), "taken once")
        self.assertEqual(pending(host), 1)
        self.assertTrue(inbox.waiting_for_read("t1"))

        inbox.confirm_read("t1", f"tool output\n\n{urgent}")
        self.assertFalse(inbox.waiting_for_read("t1"))
        inbox.on_turn_complete("t1")
        host.clock.advance(SETTLE)
        self.assertEqual(len(host.submitted), 1)
        self.assertNotIn("stop the deploy", host.submitted[0], "an urgent message read in the turn is not repeated")

    def test_an_urgent_notice_no_request_carried_goes_back_to_the_queue(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        inbox.on_turn_start("t1", "deploy")
        host.answers.append(envelope([message(conversationId=DIRECT, priority="urgent", body="stop")]))
        inbox.tick()
        self.assertIsNotNone(inbox.take_urgent("t1"))
        inbox.on_turn_complete("t1")
        self.assertEqual(pending(host), 1, "kept, never lost")
        host.clock.advance(SETTLE)
        self.assertEqual(len(host.submitted), 1)
        self.assertIn("URGENT", host.submitted[0])

    def test_urgent_queue_setting_keeps_urgent_messages_out_of_the_turn(self) -> None:
        host = FakeHost()
        inbox = followed(host, Settings(urgent="queue"))
        inbox.on_turn_start("t1", "x")
        host.answers.append(envelope([message(conversationId=DIRECT, priority="urgent")]))
        inbox.tick()
        self.assertIsNone(inbox.take_urgent("t1"))

    def test_an_urgent_message_wakes_an_idle_session(self) -> None:
        host = FakeHost()
        inbox = followed(host, Settings(delivery="next-prompt"))
        host.answers.append(envelope([message()]))
        inbox.tick()
        self.assertEqual(host.submitted, [], "next-prompt: normal messages do not wake the session")
        host.answers.append(envelope([message(conversationId=DIRECT, priority="urgent")]))
        inbox.tick()
        self.assertEqual(len(host.submitted), 1)

    def test_next_prompt_delivery_adds_the_queue_to_the_persons_prompt(self) -> None:
        host = FakeHost()
        inbox = followed(host, Settings(delivery="next-prompt"))
        host.answers.append(envelope([message(body="ready for review")]))
        inbox.tick()
        extra = inbox.on_turn_start("t1", "what next?")
        assert extra is not None
        self.assertIn("ready for review", extra)
        self.assertEqual(pending(host), 0)

    def test_a_refused_turn_sends_the_queue_with_the_next_prompt(self) -> None:
        host = FakeHost()
        host.submit_answer = False
        inbox = followed(host)
        host.answers.append(envelope([message(body="ping")]))
        inbox.tick()
        self.assertEqual(len(host.submitted), 1)
        self.assertIn("next prompt", inbox.describe())
        inbox.tick()
        self.assertEqual(len(host.submitted), 1, "held: no retry loop")
        extra = inbox.on_turn_start("t1", "hello")
        assert extra is not None
        self.assertIn("ping", extra)

    def test_marking_a_running_turn_takes_nothing_from_the_queue(self) -> None:
        host = FakeHost()
        host.submit_answer = False
        inbox = followed(host)
        host.answers.append(envelope([message(body="held")]))
        inbox.tick()
        inbox.mark_running("t1")
        self.assertEqual(pending(host), 1, "held messages wait for a real prompt")
        host.answers.append(envelope([message(conversationId=DIRECT, priority="urgent")]))
        inbox.tick()
        self.assertIsNotNone(inbox.take_urgent("t1"), "but urgent ones can join the running turn")

    def test_an_accepted_notice_no_turn_ran_is_held_for_the_next_prompt(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        host.answers.append(envelope([message(body="ping")]))
        inbox.tick()
        self.assertEqual(len(host.submitted), 1)
        host.clock.advance(inbox_module.CONFIRM_MILLIS)
        extra = inbox.on_turn_start("t1", "hello")
        assert extra is not None
        self.assertIn("ping", extra)

    def test_polls_wait_on_the_server_while_engaged_and_fall_back_on_older_servers(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        inbox.on_turn_start("t1", "x")
        host.answers.append(refusal("invalid_input", "waitSeconds is not allowed"))
        inbox.tick()
        self.assertEqual(host.calls[-2][1].get("waitSeconds"), 20)
        self.assertNotIn("waitSeconds", host.calls[-1][1], "asked again without the wait")
        inbox.tick()
        self.assertNotIn("waitSeconds", host.calls[-1][1], "and never waits again")

    def test_an_idle_session_stops_waiting_after_ten_minutes(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        inbox.on_turn_start("t1", "x")
        inbox.on_turn_complete("t1")
        host.clock.time += inbox_module.ENGAGED_MILLIS
        inbox.tick()
        self.assertNotIn("waitSeconds", host.calls[-1][1])

    def test_a_truncated_page_is_read_again_with_fewer_messages(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        host.answers.append(inbox_module.Answer(None, truncated=True))
        host.answers.append(envelope([message()]))
        inbox.tick()
        self.assertEqual(host.calls[-2][1]["limit"], 50)
        self.assertEqual(host.calls[-1][1]["limit"], 12)
        self.assertEqual(len(host.submitted), 1)

    def test_a_revoked_participant_ends_the_follow_with_one_notice(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        host.answers.append(refusal("participant_not_found", "gone"))
        inbox.tick()
        self.assertEqual(host.stored, {"version": 1, "follows": [], "notes": host.stored["notes"]})
        self.assertEqual(len(host.submitted), 1)
        self.assertIn("stopped delivering", host.submitted[0])

    def test_a_reset_history_restarts_from_now_and_says_so(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        host.answers.append(refusal("invalid_cursor", "restored"))
        host.answers.append(envelope([], checkpoint="fresh"))
        inbox.tick()
        self.assertEqual(host.stored["follows"][0]["checkpoint"], "fresh")
        self.assertIn("was reset", host.submitted[0])

    def test_transport_failures_back_off(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        host.answers.append(inbox_module.TransportError("offline"))
        inbox.tick()
        calls = len(host.calls)
        inbox.tick()
        self.assertEqual(len(host.calls), calls, "no call before the backoff ends")

    def test_the_queue_keeps_the_newest_messages_and_counts_the_rest(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        inbox.on_turn_start("t1", "x")
        host.answers.append(envelope([message() for _ in range(inbox_module.QUEUE_LIMIT + 5)]))
        inbox.tick()
        self.assertEqual(pending(host), inbox_module.QUEUE_LIMIT)
        self.assertEqual(host.stored["follows"][0]["dropped"], 5)

    def test_a_restart_restores_follows_and_queue(self) -> None:
        host = FakeHost()
        inbox = followed(host)
        inbox.on_turn_start("t1", "x")
        host.answers.append(envelope([message(body="kept")]))
        inbox.tick()
        again = Inbox(host, Settings())
        again.restore()
        self.assertEqual(again.follows(), 1)
        host.clock.advance(SETTLE)
        self.assertIn("kept", host.submitted[-1])

    def test_follow_input_and_limits(self) -> None:
        read = inbox_module.read_follow_input
        self.assertIn("serverId and participantId", read({"serverId": SERVER}))
        self.assertIn("channelIds", read({"serverId": SERVER, "participantId": ME, "channelIds": "x"}))
        self.assertIn("directChats", read({"serverId": SERVER, "participantId": ME, "directChats": "all"}))
        host = FakeHost()
        inbox = Inbox(host, Settings())
        for index in range(inbox_module.FOLLOW_LIMIT):
            inbox.follow(read({"serverId": f"s{index}", "participantId": ME}))
        self.assertIn("already follows", inbox.follow(read({"serverId": "s9", "participantId": ME})))
        self.assertIn("Stopped following", inbox.unfollow("s0"))


if __name__ == "__main__":
    unittest.main()
