// @ts-check
/**
 * talkto-plugin for OpenClaw: binds the delivery rules (signals.mjs) to OpenClaw's plugin API.
 *
 * - `after_tool_call` sees the agent's TalkTo MCP calls: create_signal (save the link),
 *   revoke_signal (forget it) and get_updates (the agent read).
 * - Lifecycle agent events say when a session's turn starts and ends.
 * - A Gateway service checks the saved links and delivers:
 *   `api.runtime.system.enqueueSystemEvent` + `requestHeartbeat` for queued notices,
 *   `api.session.workflow.steerActiveRun` for urgent ones.
 * - Links are kept in the plugin's own keyed store (OpenClaw's state database). It never holds
 *   a token: OpenClaw's MCP client keeps the TalkTo sign-in.
 */
import { Signals, settingsFrom } from "./signals.mjs";

export const pluginId = "talkto-plugin";
export const serviceId = "talkto-signals";
export const subscriptionId = "talkto-turns";
export const command = "talkto-inbox";
/** Rows kept at most; a link lasts at most 7 days, so rows expire a day after that. */
const storeOptions = { namespace: "follows", maxEntries: 500, defaultTtlMs: 8 * 86_400_000 };
/** How often the service looks at its links; each link has its own, slower check interval. */
export const tickMillis = 1_000;

/** What the agent reads in its system prompt while the plugin is loaded. */
export const guidance =
  "TalkTo plugin: after you register or recover a TalkTo participant, call TalkTo's create_signal once with your serverId, participantId and the channelIds and directChats you use for get_updates. The plugin saves the link and tells this session when TalkTo messages arrive, urgent direct messages during a turn. Then read them with get_updates. Do not schedule TalkTo checks. Never paste the link anywhere.";

/**
 * Everything from outside OpenClaw: network, clock and a repeating timer.
 * @typedef {object} Deps
 * @property {import("./signals.mjs").Host["fetch"]} fetch
 * @property {() => number} now
 * @property {(ms: number, run: () => void) => () => void} every Repeats `run`; the result stops it.
 */

/** @param {import("./host.js").Api} api @param {Deps} deps */
export const register = (api, deps) => {
  const config = api.pluginConfig ?? {};
  const settings = settingsFrom(
    new Map([
      ["delivery", config.delivery],
      ["urgent", config.urgent],
      ["pollSeconds", config.pollSeconds],
    ]),
  );
  /** @type {import("./host.js").KeyedStore<unknown> | null} */
  let store = null;
  const follows = () => (store ??= api.runtime.state.openKeyedStoreV2(storeOptions));

  const signals = new Signals(
    {
      steer: async (target, text, key) => {
        const result = await api.session.workflow.steerActiveRun({
          sessionKey: target.sessionKey,
          text,
          idempotencyKey: key,
        });
        return result.steered;
      },
      notify: async (target, text, wake) => {
        const owner = target.agentId === null ? {} : { agentId: target.agentId };
        const accepted = api.runtime.system.enqueueSystemEvent(text, {
          sessionKey: target.sessionKey,
          ...owner,
          contextKey: target.contextKey,
          replace: true,
        });
        if (accepted && wake)
          api.runtime.system.requestHeartbeat({
            source: "other",
            intent: "immediate",
            reason: pluginId,
            sessionKey: target.sessionKey,
            ...owner,
          });
        return accepted;
      },
      save: async (key, follow) => {
        await follows().register(key, follow);
      },
      remove: async (key) => {
        await follows().delete(key);
      },
      fetch: deps.fetch,
      now: deps.now,
    },
    settings,
  );

  api.on("after_tool_call", async (event, ctx) => {
    await signals.observeTool({
      toolName: event.toolName,
      params: new Map([
        ["serverId", event.params.serverId],
        ["participantId", event.params.participantId],
      ]),
      result: event.result,
      failed: event.error !== undefined,
      durationMs: event.durationMs ?? 0,
      sessionKey: ctx.sessionKey ?? null,
      agentId: ctx.agentId ?? null,
    });
  });
  api.on("session_end", async (event, ctx) => {
    await signals.endSession(event.sessionKey ?? ctx.sessionKey ?? null, event.reason ?? "unknown");
  });
  api.agent.events.registerAgentEventSubscription({
    id: subscriptionId,
    description: "Knows when a session's turn runs, so TalkTo notices wait for its end.",
    streams: ["lifecycle"],
    phases: ["start", "end", "error"],
    payload: "metadata",
    handle: async (event) => {
      if (event.sessionKey === undefined) return;
      if (event.data.phase === "start") await signals.runStarted(event.sessionKey, event.runId);
      else signals.runEnded(event.sessionKey, event.runId);
    },
  });

  /** @type {(() => void) | null} */
  let stop = null;
  api.registerService({
    id: serviceId,
    start: async () => {
      signals.restore(await follows().entries());
      stop?.();
      stop = deps.every(tickMillis, () => {
        signals.tick().catch((cause) => api.logger.warn(`TalkTo check failed: ${String(cause)}`));
      });
    },
    stop: () => {
      stop?.();
      stop = null;
    },
  });

  api.registerCommand({
    name: command,
    description: "Show the TalkTo links this session follows and what waits.",
    acceptsArgs: false,
    agentPromptGuidance: [guidance],
    handler: (ctx) => ({ text: signals.describe(ctx.sessionKey ?? null) }),
  });
};
