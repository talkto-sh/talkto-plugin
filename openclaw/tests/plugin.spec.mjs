// talkto-plugin for OpenClaw against a fake OpenClaw plugin API: what it registers, and the path
// from a create_signal result to a system event, a wake and a steer.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import entry from "../index.mjs";
import { command, guidance, pluginId, register, serviceId, subscriptionId } from "../plugin.mjs";
import { engagedPollMillis, settleMillis } from "../signals.mjs";

const server = "7c1e9a52-3b0f-4c55-9d7e-0d2f3c4b5a61";
const me = "22222222-2222-4222-8222-222222222222";
const signal = "0b7a3c1d-2e4f-4a6b-8c9d-1e2f3a4b5c6d";
const url = `https://talkto.sh/v1/signals/${server}/${signal}.${"A".repeat(42)}B`;
const later = new Date(Date.UTC(2030, 0, 1)).toISOString();
const session = "agent:main:main";
const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

/** An OpenClaw plugin API that records registrations and calls. */
const fakeOpenClaw = (pluginConfig = {}) => {
  const rows = new Map();
  const o = {
    hooks: new Map(),
    subscriptions: [],
    services: [],
    commands: [],
    events: [],
    wakes: [],
    steers: [],
    stores: [],
    warnings: [],
    steering: true,
    api: {
      id: pluginId,
      pluginConfig,
      logger: { info: () => undefined, warn: (text) => o.warnings.push(text) },
      runtime: {
        system: {
          enqueueSystemEvent: (text, options) => {
            o.events.push({ text, options });
            return true;
          },
          requestHeartbeat: (request) => o.wakes.push(request),
        },
        state: {
          openKeyedStoreV2: (options) => {
            o.stores.push(options);
            return {
              register: async (key, value) => rows.set(key, structuredClone(value)),
              lookup: async (key) => rows.get(key),
              delete: async (key) => rows.delete(key),
              entries: async () => [...rows].map(([key, value]) => ({ key, value })),
            };
          },
        },
      },
      session: {
        workflow: {
          steerActiveRun: async (params) => {
            o.steers.push(params);
            return o.steering
              ? { steered: true, runId: "run-1" }
              : { steered: false, reason: "no_active_run" };
          },
        },
      },
      agent: {
        events: {
          registerAgentEventSubscription: (subscription) => o.subscriptions.push(subscription),
        },
      },
      on: (hook, handler) => o.hooks.set(hook, handler),
      registerService: (service) => o.services.push(service),
      registerCommand: (definition) => o.commands.push(definition),
    },
    rows,
  };
  return o;
};

/** Runs register with a manual clock, a scripted link and a timer the test fires. */
const loaded = (answers = [], pluginConfig = {}) => {
  const o = fakeOpenClaw(pluginConfig);
  let clock = 5_000_000;
  const ticks = [];
  const requests = [];
  register(o.api, {
    fetch: async (target) => {
      requests.push(target);
      return Response.json({
        more: false,
        cursor: null,
        expiresAt: later,
        ...(answers.shift() ?? { pending: 0, urgent: 0 }),
      });
    },
    now: () => clock,
    every: (_ms, run) => {
      ticks.push(run);
      return () => ticks.splice(0);
    },
  });
  return {
    o,
    requests,
    advance: (ms) => {
      clock += ms;
    },
    /** Fire the service timer once and wait for its check and delivery. */
    tick: async () => {
      for (const run of ticks) run();
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    toolEnd: (toolName, result, params = { serverId: server, participantId: me }) =>
      o.hooks.get("after_tool_call")(
        { toolName, params, result, durationMs: 40 },
        { toolName, sessionKey: session, agentId: "main", runId: "run-1" },
      ),
    lifecycle: (phase, runId = "run-1") =>
      o.subscriptions[0].handle({
        runId,
        stream: "lifecycle",
        data: { phase },
        sessionKey: session,
      }),
  };
};
const created = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        data: { signalId: signal, url, expiresAt: later, minIntervalSeconds: 10 },
      }),
    },
  ],
};

test("the entry matches the manifests and registers hooks, a service, a turn subscription and a command", async () => {
  const manifest = await json("../openclaw.plugin.json");
  const pkg = await json("../package.json");
  assert.equal(entry.id, pluginId);
  assert.equal(manifest.id, pluginId);
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.description, manifest.description);
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(pkg.openclaw.extensions, ["./index.mjs"]);
  assert.equal(manifest.activation.onStartup, true, "the service must start with the Gateway");
  assert.deepEqual(Object.keys(manifest.configSchema.properties).sort(), [
    "delivery",
    "pollSeconds",
    "urgent",
  ]);
  assert.equal(pkg.dependencies, undefined, "the plugin needs no dependency at run time");

  const { o } = loaded();
  assert.deepEqual([...o.hooks.keys()].sort(), ["after_tool_call", "session_end"]);
  assert.equal(o.services[0].id, serviceId);
  assert.equal(o.subscriptions[0].id, subscriptionId);
  assert.deepEqual(o.subscriptions[0].streams, ["lifecycle"]);
  assert.equal(o.subscriptions[0].payload, "metadata");
  assert.equal(o.commands[0].name, command);
  assert.deepEqual(o.commands[0].agentPromptGuidance, [guidance]);
  assert.match(guidance, /create_signal/);
});

test("the repository root carries the same OpenClaw manifest, for git installs", async () => {
  assert.deepEqual(await json("../../openclaw.plugin.json"), await json("../openclaw.plugin.json"));
  const root = await json("../../package.json");
  assert.deepEqual(root.openclaw.extensions, ["./openclaw/index.mjs"]);
  assert.equal(root.dependencies, undefined);
});

test("create_signal → idle check → a system event for the session and an immediate wake", async () => {
  const run = loaded([{ pending: 2, urgent: 0, cursor: "00000000-0000-4000-8000-000000000002" }]);
  const { o } = run;
  await o.services[0].start();
  await run.lifecycle("start");
  await run.toolEnd("talkto__create_signal", created);
  assert.match(o.steers[0].text, /signal link saved/);
  assert.equal(o.steers[0].sessionKey, session);
  assert.equal(o.rows.size, 1);
  assert.equal(JSON.stringify([...o.rows.values()]).includes("token"), false);
  await run.lifecycle("end");
  run.advance(settleMillis);
  await run.tick();
  assert.equal(run.requests.length, 1);
  assert.equal(o.events.length, 1);
  assert.match(o.events[0].text, /^TalkTo: 2 new messages/);
  assert.deepEqual(o.events[0].options, {
    sessionKey: session,
    agentId: "main",
    contextKey: `talkto-plugin:${server}:${me}`,
    replace: true,
  });
  assert.deepEqual(o.wakes, [
    {
      source: "other",
      intent: "immediate",
      reason: pluginId,
      sessionKey: session,
      agentId: "main",
    },
  ]);
  // The wake's turn starts and takes the event: the cursor is saved.
  await run.lifecycle("start", "run-2");
  assert.equal([...o.rows.values()][0].cursor, "00000000-0000-4000-8000-000000000002");
});

test("an urgent direct message during a turn is steered in, with no system event", async () => {
  const run = loaded([{ pending: 1, urgent: 1, cursor: "00000000-0000-4000-8000-000000000001" }]);
  const { o } = run;
  await o.services[0].start();
  await run.toolEnd("talkto__create_signal", created);
  await run.lifecycle("start");
  await run.tick();
  assert.equal(o.events.length, 0);
  assert.match(o.steers.at(-1).text, /urgent direct message/);
  assert.equal(o.steers.at(-1).sessionKey, session);
});

test("next-prompt delivery adds the event without a wake", async () => {
  const run = loaded([{ pending: 1, urgent: 0, cursor: "00000000-0000-4000-8000-000000000001" }], {
    delivery: "next-prompt",
  });
  const { o } = run;
  await o.services[0].start();
  await run.toolEnd("talkto__create_signal", created);
  await run.tick();
  assert.equal(o.events.length, 1);
  assert.equal(o.wakes.length, 0);
});

test("saved links come back after a Gateway restart", async () => {
  const first = loaded();
  await first.o.services[0].start();
  await first.toolEnd("talkto__create_signal", created);
  first.o.services[0].stop();

  const run = loaded([{ pending: 1, urgent: 0, cursor: "00000000-0000-4000-8000-000000000001" }]);
  for (const [key, value] of first.o.rows) run.o.rows.set(key, value);
  await run.o.services[0].start();
  run.advance(engagedPollMillis);
  await run.tick();
  assert.equal(run.requests.length, 1);
  assert.equal(run.o.events.length, 1);
});

test("/talkto-inbox reports the session's links without the link itself", async () => {
  const run = loaded();
  await run.o.services[0].start();
  await run.toolEnd("talkto__create_signal", created);
  const reply = await run.o.commands[0].handler({ channel: "webchat", sessionKey: session });
  assert.match(reply.text, new RegExp(`participant ${me} on server ${server}: nothing waiting`));
  assert.doesNotMatch(reply.text, /\/v1\/signals\//);
});
