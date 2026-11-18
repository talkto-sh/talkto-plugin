// How long the plugin takes Claude Code's prompt cache to live. A held summary goes just before it
// expires, so a lifetime read too long would wake a session whose cache is already cold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheMinutesOf } from "../hooks/cache.ts";

const none = {
  force5m: undefined,
  enable1h: undefined,
  ttl: undefined,
  bedrock: undefined,
  vertex: undefined,
  foundry: undefined,
};

test("a subscription keeps an hour; a cloud provider five minutes; settings decide first", () => {
  assert.equal(cacheMinutesOf(none), 60);
  assert.equal(cacheMinutesOf({ ...none, bedrock: "1" }), 5);
  assert.equal(cacheMinutesOf({ ...none, vertex: "true" }), 5);
  assert.equal(cacheMinutesOf({ ...none, foundry: "1" }), 5);
  assert.equal(cacheMinutesOf({ ...none, bedrock: "0" }), 60, "0 turns it off");
  assert.equal(cacheMinutesOf({ ...none, bedrock: "1", ttl: "1h" }), 60);
  assert.equal(cacheMinutesOf({ ...none, bedrock: "1", enable1h: "1" }), 60);
  assert.equal(cacheMinutesOf({ ...none, ttl: "5m" }), 5);
  assert.equal(cacheMinutesOf({ ...none, enable1h: "1", force5m: "1" }), 5, "5m overrides all");
});
