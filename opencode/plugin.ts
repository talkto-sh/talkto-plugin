/**
 * talkto-plugin for OpenCode 2.
 * - The person connects TalkTo once in OpenCode (browser sign-in); OpenCode
 *   stores and renews the credential (see signin.ts).
 * - TalkTo's tools are registered as `talkto_<name>` from TalkTo's own tool
 *   list, plus `talkto_follow` and `talkto_unfollow`.
 * - A follow belongs to the OpenCode session that called it and names the
 *   agent's own participant; nothing is inferred from the sign-in.
 * - Queued messages go in as a queued prompt (a turn of its own once the
 *   session is idle); urgent ones are steered into the running turn and
 *   count as read when OpenCode reports the row delivered.
 */
import {
  Inbox,
  isSaved,
  readFollowInput,
  type Host,
  type Saved,
  type Settings,
} from "./core/inbox.ts";
import { callTool, listTools, type Endpoint, type ToolInfo } from "./core/mcp.ts";
import { isText, type ToolAnswer } from "./core/talkto.ts";
import {
  followDescription,
  followSchema,
  unfollowDescription,
  unfollowSchema,
} from "./core/tools.ts";
import type { Context, Event, Plugin, Tool } from "./opencode.ts";
import { integrationID, method, type SignInDeps } from "./signin.ts";

export const version = "0.1.0";
const keyPrefix = "session:";

export interface Deps extends SignInDeps {
  readonly settings: Settings;
}

const answerText = (answer: ToolAnswer) => {
  const text = answer.content
    .flatMap((block) => (block.text === undefined ? [] : [block.text]))
    .join("\n");
  return text !== "" ? text : JSON.stringify(answer.structuredContent ?? null);
};
/** OpenCode turns a rejected tool call into a defect, so failures are answered as text. */
const failed = (cause: unknown) =>
  `TalkTo call failed: ${cause instanceof Error ? cause.message : String(cause)}`;

/** One OpenCode session's delivery. */
interface Delivery {
  readonly inbox: Inbox;
  turns: number;
  turnId: string | null;
}

export const plugin = (deps: Deps): Plugin => ({
  id: "talkto-plugin",
  setup: async (ctx: Context) => {
    // OpenCode 1.18 runs this setup too, without these domains: there TalkTo is reached through its MCP server.
    if (!("session" in ctx && "tool" in ctx && "integration" in ctx && "event" in ctx)) return;
    const lifetime = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sessions = new Map<string, Delivery>();
    /** Steered rows waiting for `session.inbox.delivered`: row id → session and turn. */
    const steering = new Map<string, { readonly sessionID: string; readonly turnId: string }>();
    let remote: ReadonlyArray<ToolInfo> = [];

    const endpoint: Endpoint = {
      url: deps.mcpUrl,
      token: async () => {
        try {
          const connection = await ctx.integration.connection.active(integrationID);
          if (connection === undefined) return null;
          const credential = await ctx.integration.connection.resolve(connection);
          return credential?.type === "oauth" && isText(credential.access)
            ? credential.access
            : null;
        } catch {
          // OpenCode could not renew the stored sign-in.
          return null;
        }
      },
      clientName: "talkto-plugin for OpenCode",
      clientVersion: version,
      fetch: deps.fetch,
    };

    const later = (ms: number, run: () => Promise<void>) => {
      if (lifetime.signal.aborted) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        run().catch(() => undefined);
      }, ms);
      timers.add(timer);
    };

    const hostFor = (sessionID: string): Host => ({
      call: (tool, args) => callTool(endpoint, tool, args),
      submit: async (text) => {
        // OpenCode keeps a queued row and starts it as a turn of its own once the session is idle.
        await ctx.session.prompt({ sessionID, text, delivery: "queue" });
        return true;
      },
      inject: async (text) => {
        const turnId = sessions.get(sessionID)?.turnId ?? null;
        if (turnId === null) return false;
        const row = await ctx.session.prompt({ sessionID, text, delivery: "steer" });
        steering.set(row.id, { sessionID, turnId });
        return true;
      },
      load: async () => {
        const value = await ctx.storage.get(`${keyPrefix}${sessionID}`);
        if (!isText(value)) return null;
        try {
          const saved: unknown = JSON.parse(value);
          return isSaved(saved) ? saved : null;
        } catch {
          return null;
        }
      },
      save: async (state: Saved) =>
        state.follows.length === 0 && state.notes.length === 0
          ? ctx.storage.remove(`${keyPrefix}${sessionID}`)
          : ctx.storage.set(`${keyPrefix}${sessionID}`, JSON.stringify(state)),
      now: async () => deps.now(),
      after: later,
      status: () => undefined,
      connectionHint: "Ask the person to connect TalkTo in OpenCode (sign in with the browser).",
    });

    /** The session's delivery, restored from storage the first time it is needed. */
    const deliveryFor = async (sessionID: string) => {
      const known = sessions.get(sessionID);
      if (known !== undefined) return known;
      const inbox = new Inbox(hostFor(sessionID), deps.settings);
      const created: Delivery = { inbox, turns: 0, turnId: null };
      sessions.set(sessionID, created);
      await inbox.restore();
      const poll = setInterval(() => {
        inbox.tick().catch(() => undefined);
      }, deps.settings.pollMillis);
      timers.add(poll);
      return created;
    };

    /** Fetches TalkTo's tool list once a sign-in exists; the transform below adds it. */
    const loadRemoteTools = async () => {
      if (remote.length > 0) return;
      try {
        remote = await listTools(endpoint);
        if (remote.length > 0) await ctx.tool.reload();
      } catch {
        // Not connected yet: tried again at the next run.
      }
    };

    const remoteTool = (info: ToolInfo): Tool => ({
      name: `talkto_${info.name}`,
      description: info.description,
      input: info.inputSchema,
      options: { codemode: false },
      execute: async (input) => {
        try {
          return { content: answerText(await callTool(endpoint, info.name, input)) };
        } catch (cause) {
          return { content: failed(cause) };
        }
      },
    });

    await ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = "TalkTo";
      });
      editor.method.update(method(deps));
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "talkto_follow",
        description: followDescription("this OpenCode session"),
        input: followSchema,
        options: { codemode: false },
        execute: async (input, context) => {
          const read = readFollowInput(new Map(Object.entries(input)));
          if (!read.ok) return { content: read.problem };
          const delivery = await deliveryFor(context.sessionID);
          return { content: await delivery.inbox.follow(read.input) };
        },
      });
      editor.add({
        name: "talkto_unfollow",
        description: unfollowDescription,
        input: unfollowSchema,
        options: { codemode: false },
        execute: async (input, context) => {
          const delivery = await deliveryFor(context.sessionID);
          return { content: await delivery.inbox.unfollow(String(input["serverId"] ?? "")) };
        },
      });
      for (const info of remote) editor.add(remoteTool(info));
    });

    const onEvent = async (event: Event) => {
      const sessionID = event.data?.sessionID;
      if (event.type === "session.inbox.delivered") {
        const steered = steering.get(event.data?.inboxID ?? "");
        if (steered === undefined) return;
        steering.delete(event.data?.inboxID ?? "");
        sessions.get(steered.sessionID)?.inbox.onStep(steered.turnId);
        return;
      }
      if (sessionID === undefined) return;
      const delivery = sessions.get(sessionID);
      if (event.type === "session.execution.started") {
        await loadRemoteTools();
        if (delivery === undefined) return;
        delivery.turns += 1;
        delivery.turnId = `${sessionID}:${delivery.turns}`;
        delivery.inbox.onTurnStart(delivery.turnId);
        return;
      }
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      ) {
        const ended = delivery?.turnId ?? null;
        if (delivery === undefined || ended === null) return;
        delivery.turnId = null;
        await delivery.inbox.onTurnComplete(ended);
      }
    };

    const listening = (async () => {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal }))
        await onEvent(event).catch(() => undefined);
    })();
    listening.catch(() => undefined);

    // Sessions that followed before a restart resume their polls.
    const saved = await ctx.storage.scan({ prefix: keyPrefix }).catch(() => ({ entries: [] }));
    for (const entry of saved.entries) await deliveryFor(entry.key.slice(keyPrefix.length));
    await loadRemoteTools();

    return () => {
      lifetime.abort();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  },
});
