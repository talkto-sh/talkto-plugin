/**
 * talkto-plugin for Claude Code: binds the session's TalkTo inbox
 * (`core/inbox.ts`, a copy of `integrations/core/src`) to the engine.
 *
 * - TalkTo is reached only through Claude Code's own MCP connection
 *   (`$.mcp.call`): the plugin never sees or stores a token.
 * - The agent starts delivery itself with the `follow` tool, naming its own
 *   participant; nothing is inferred from the connection.
 * - Turns are tracked on the main loop only; subagents never receive notices.
 */
import type { EngineInterface, PluginOptions, Register } from "claude-code";
import {
  Inbox,
  isSaved,
  readFollowInput,
  type Delivery,
  type Host,
  type Settings,
  type WaitPolicy,
} from "./core/inbox.ts";
import {
  followDescription,
  followSchema,
  unfollowDescription,
  unfollowSchema,
} from "./core/tools.ts";

const command = "talkto-inbox";
const notInteractive = "talkto-plugin delivers only in an interactive session.";
/** The manifest's key for the bundled TalkTo MCP server. */
const bundledServer = "talkto";

const followSpec = {
  name: "follow",
  description: followDescription("this Claude Code session"),
  inputSchema: followSchema,
  isDeferred: false,
} as const;

const unfollowSpec = {
  name: "unfollow",
  description: unfollowDescription,
  inputSchema: unfollowSchema,
  isDeferred: false,
} as const;

const settingsOf = (options: PluginOptions): Settings & { readonly server: string } => {
  const delivery: Delivery = options["delivery"] === "next-prompt" ? "next-prompt" : "idle";
  const seconds = Number(options["pollSeconds"] ?? 15);
  const waiting = options["wait"];
  const wait: WaitPolicy = waiting === "always" || waiting === "never" ? waiting : "auto";
  return {
    delivery,
    urgent: options["urgent"] === "queue" ? "queue" : "inject",
    pollMillis: Math.max(5, Math.min(300, Number.isFinite(seconds) ? seconds : 15)) * 1000,
    wait,
    server: String(options["mcpServer"] ?? "").trim(),
  };
};

/** The TalkTo MCP server's name in this session: configured, bundled, or found by its tools. */
const serverOf = async ($: EngineInterface, configured: string): Promise<string> => {
  if (configured !== "") return configured;
  const bundled = await $.mcp.connect(bundledServer);
  if (bundled.isConnected) return bundled.server;
  const names = new Set((await $.tool.list()).map((tool) => tool.name));
  for (const name of names) {
    const match = /^mcp__(.+)__get_updates$/.exec(name);
    if (match?.[1] !== undefined && names.has(`mcp__${match[1]}__register_participant`))
      return match[1];
  }
  throw new Error(
    "no TalkTo MCP server is connected in this session; run /mcp and authenticate TalkTo",
  );
};

const hostOf = ($: EngineInterface, sessionId: string, configured: string): Host => {
  const key = `session:${sessionId}`;
  let server: string | null = null;
  return {
    call: async (tool, args) => {
      server ??= await serverOf($, configured);
      try {
        return await $.mcp.call(server, tool, args);
      } catch (cause) {
        server = null;
        throw cause;
      }
    },
    submit: async (text) => !("drop" in (await $.prompt.submit({ text }))),
    inject: async (text) =>
      !(
        "deny" in
        (await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }))
      ),
    load: async () => {
      const stored = await $.store.get(key);
      return isSaved(stored) ? stored : null;
    },
    save: async (state) =>
      state.follows.length === 0 && state.notes.length === 0
        ? $.store.delete(key)
        : $.store.set(key, state),
    now: () => $.clock.now(),
    after: (ms, run) => {
      $.clock.after(ms, () => run().catch(() => undefined));
    },
    status: (text) => $.ui.status(text),
    connectionHint: "Check /mcp and authenticate TalkTo.",
  };
};

export const register: Register = (on, options) => {
  const settings = settingsOf(options);
  let inbox: Inbox | null = null;

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    // A -p run or an SDK host has nobody idle to deliver to.
    if (!e.isInteractive) return started;
    const created = new Inbox(hostOf($, await $.session.id(), settings.server), settings);
    inbox = created;
    await created.restore();
    await $.tool.register(followSpec);
    await $.tool.register(unfollowSpec);
    await $.command.register({
      name: command,
      description: "Show which TalkTo participant this session follows and what is queued.",
    });
    $.clock.every(settings.pollMillis, () => created.tick().catch(() => undefined));
    return started;
  });

  on("tool.call", { tool: "mcp__talkto-plugin__follow" }, async (_$, e) => {
    if (inbox === null) return { deny: notInteractive };
    const read = readFollowInput(new Map(Object.entries(e)));
    return { result: read.ok ? await inbox.follow(read.input) : read.problem };
  }).catch(() => ({ deny: "talkto-plugin could not start the follow; try again." }));

  on("tool.call", { tool: "mcp__talkto-plugin__unfollow" }, async (_$, e) => {
    if (inbox === null) return { deny: notInteractive };
    const serverId = "serverId" in e ? String(e.serverId) : "";
    return { result: await inbox.unfollow(serverId) };
  }).catch(() => ({ deny: "talkto-plugin could not stop the follow; try again." }));

  on("command.run", { command }, async () => ({
    text: inbox?.describe() ?? notInteractive,
  }));

  on("turn.start", async (_$, e, next) => {
    if (e.agentId === undefined) inbox?.onTurnStart(e.turnId);
    return next(e);
  });

  on("turn.step", async function* (_$, e, next) {
    if (e.agentId === undefined) inbox?.onStep(e.turnId);
    return yield* next(e);
  });

  on("turn.complete", async (_$, e, next) => {
    const completed = await next(e);
    if (e.agentId === undefined) await inbox?.onTurnComplete(e.turnId);
    return completed;
  });

  // With next-prompt delivery, what is queued rides along with the person's own prompt.
  on("prompt.submit", async (_$, e, next) => {
    if (inbox === null || e.origin.kind !== "composer" || e.command !== undefined) return next(e);
    const queued = await inbox.takeForPrompt();
    return next(queued === null ? e : { ...e, context: [...(e.context ?? []), queued] });
  }).catch((_$, e, next) => next(e));
};
