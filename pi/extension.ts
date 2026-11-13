/**
 * talkto-plugin for pi. pi has no MCP client, so this extension is pi's
 * TalkTo client:
 * - `/login talkto` signs in through the browser; pi stores and renews the
 *   credential (see login.ts). Nothing here writes a token anywhere.
 * - TalkTo's tools are registered as `talkto_<name>` from TalkTo's own tool
 *   list, so they stay in step with the server.
 * - `talkto_follow` starts delivery for the participant the agent names;
 *   nothing is inferred from the sign-in, which identifies a person, not an
 *   agent.
 * - Queued messages arrive as one follow-up turn once pi is idle; urgent ones
 *   are steered into the running turn and read before its next model request.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Inbox,
  isSaved,
  readFollowInput,
  type Host,
  type Saved,
  type Settings,
} from "./core/inbox.ts";
import { SignInRequired, callTool, listTools, type Endpoint } from "./core/mcp.ts";
import type { FormFetch } from "./core/oauth.ts";
import { isObject, isText, messageIdsOf, type ToolAnswer } from "./core/talkto.ts";
import {
  followDescription,
  followSchema,
  unfollowDescription,
  unfollowSchema,
} from "./core/tools.ts";
import { provider, providerName } from "./login.ts";
import type { Context, Message, Pi, ToolResult } from "./pi.ts";

export const version = "0.1.0";
const statusKey = "talkto";
const command = "talkto-inbox";
/** How long a sent notice may take to appear as a user message before it counts as not delivered. */
export const confirmMillis = 15_000;
/** TalkTo tools whose results show the agent messages. */
const reads = new Set(["get_updates", "read_messages"]);

/** Everything from outside: configuration, clock, network and where session state is kept. */
export interface Deps {
  readonly mcpUrl: string;
  readonly fetch: FormFetch;
  readonly now: () => number;
  /** Folder for per-session follow state (participant, checkpoint, queue; never a credential). */
  readonly stateDir: string;
  readonly settings: Settings;
}

/** The text of a user message, however pi shaped its content. */
const textOf = (message: Message) => {
  const content = message.content;
  if (isText(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isObject(part)) return "";
      const text = new Map(Object.entries(part)).get("text");
      return isText(text) ? text : "";
    })
    .join("");
};

const answerText = (answer: ToolAnswer) => {
  const text = answer.content
    .flatMap((block) => (block.text === undefined ? [] : [block.text]))
    .join("\n");
  return text !== "" ? text : JSON.stringify(answer.structuredContent ?? null);
};
const result = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: null });

/** A notice sent with sendUserMessage, waiting to appear as a user message. */
interface Sent {
  readonly text: string;
  readonly settle: (seen: boolean) => void;
}

export const extension =
  (deps: Deps) =>
  (pi: Pi): void => {
    let ctx: Context | null = null;
    let inbox: Inbox | null = null;
    let turn = 0;
    let turnId: string | null = null;
    let remoteTools = false;
    let toldToSignIn = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let sent: Sent[] = [];

    const endpoint: Endpoint = {
      url: deps.mcpUrl,
      token: async () => {
        if (ctx === null) return null;
        try {
          return (await ctx.modelRegistry.getProviderAuth(providerName))?.auth.apiKey ?? null;
        } catch {
          // pi could not renew the stored sign-in.
          return null;
        }
      },
      clientName: "talkto-plugin for pi",
      clientVersion: version,
      fetch: deps.fetch,
    };

    const later = (ms: number, run: () => Promise<void>) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run().catch(() => undefined);
      }, ms);
      timers.add(timer);
    };

    /** Resolves true once `text` appears as a user message, false after confirmMillis. */
    const confirmed = (text: string) =>
      new Promise<boolean>((resolve) => {
        const entry: Sent = {
          text,
          settle: (seen) => {
            sent = sent.filter((item) => item !== entry);
            resolve(seen);
          },
        };
        sent.push(entry);
        later(confirmMillis, async () => entry.settle(false));
      });

    const statePath = (sessionId: string) =>
      join(deps.stateDir, `${encodeURIComponent(sessionId)}.json`);

    const hostFor = (sessionId: string): Host => ({
      call: (tool, args) => callTool(endpoint, tool, args),
      submit: async (text) => {
        if (ctx === null || !ctx.isIdle() || ctx.hasPendingMessages())
          throw new Error("pi is not idle");
        const seen = confirmed(text);
        pi.sendUserMessage(text, { deliverAs: "followUp" });
        return seen;
      },
      inject: async (text) => {
        if (ctx === null || ctx.isIdle()) return false;
        const steeredIn = turnId;
        pi.sendUserMessage(text, { deliverAs: "steer" });
        // Read at the turn's next model request; until then the inbox may add a follow-up.
        confirmed(text)
          .then((seen) => {
            if (seen && steeredIn !== null) inbox?.onStep(steeredIn);
          })
          .catch(() => undefined);
        return true;
      },
      load: async () => {
        try {
          const saved: unknown = JSON.parse(await readFile(statePath(sessionId), "utf8"));
          return isSaved(saved) ? saved : null;
        } catch {
          return null;
        }
      },
      save: async (state: Saved) => {
        if (state.follows.length === 0 && state.notes.length === 0) {
          await rm(statePath(sessionId), { force: true });
          return;
        }
        await mkdir(deps.stateDir, { recursive: true, mode: 0o700 });
        await writeFile(statePath(sessionId), JSON.stringify(state), { mode: 0o600 });
      },
      now: async () => deps.now(),
      after: later,
      status: (text) => ctx?.ui.setStatus(statusKey, text),
      connectionHint: "Ask the person to run /login talkto in pi.",
    });

    /**
     * Registers TalkTo's own tools once a sign-in exists. pi adds a tool
     * registered mid-session to the active tools, but a turn keeps the tool
     * list it started with, so this runs before a turn starts and right after
     * `/login talkto`, with the new token (pi has not stored it yet).
     */
    const registerRemoteTools = async (freshToken: string | null = null) => {
      if (remoteTools || (ctx === null && freshToken === null)) return;
      const lister: Endpoint =
        freshToken === null ? endpoint : { ...endpoint, token: async () => freshToken };
      try {
        const tools = await listTools(lister);
        if (remoteTools) return;
        for (const tool of tools)
          pi.registerTool({
            name: `talkto_${tool.name}`,
            label: tool.title ?? `TalkTo ${tool.name}`,
            description: tool.description,
            parameters: tool.inputSchema,
            execute: async (_id, params) => {
              const answer = await callTool(endpoint, tool.name, params);
              if (answer.isError) throw new Error(answerText(answer));
              // An urgent message the agent read itself needs no "may not have read it" turn.
              if (reads.has(tool.name) && turnId !== null)
                inbox?.onRead(turnId, messageIdsOf(answer));
              return result(answerText(answer));
            },
          });
        remoteTools = true;
      } catch (cause) {
        if (ctx === null || !ctx.hasUI) return;
        if (freshToken !== null) {
          ctx.ui.notify(
            "TalkTo: signed in, but TalkTo's tools could not be loaded yet. pi tries again before your next prompt.",
            "warning",
          );
          return;
        }
        if (!(cause instanceof SignInRequired) || toldToSignIn) return;
        toldToSignIn = true;
        ctx.ui.notify("TalkTo: run /login talkto to connect TalkTo's tools.", "info");
      }
    };

    const stop = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const entry of sent) entry.settle(false);
      inbox = null;
      ctx = null;
    };

    pi.registerProvider(
      providerName,
      provider(deps, (accessToken) => registerRemoteTools(accessToken)),
    );

    pi.registerTool({
      name: "talkto_follow",
      label: "TalkTo follow",
      description: followDescription("this pi session"),
      parameters: followSchema,
      execute: async (_id, params) => {
        if (inbox === null)
          throw new Error("TalkTo delivers messages only in an interactive pi session.");
        const read = readFollowInput(new Map(Object.entries(params)));
        return result(read.ok ? await inbox.follow(read.input) : read.problem);
      },
    });
    pi.registerTool({
      name: "talkto_unfollow",
      label: "TalkTo unfollow",
      description: unfollowDescription,
      parameters: unfollowSchema,
      execute: async (_id, params) => {
        if (inbox === null)
          throw new Error("TalkTo delivers messages only in an interactive pi session.");
        return result(await inbox.unfollow(String(params["serverId"] ?? "")));
      },
    });
    pi.registerCommand(command, {
      description: "Show which TalkTo participant this session follows and what is queued.",
      handler: async (_args, context) =>
        context.ui.notify(inbox?.describe() ?? "TalkTo: no session is running.", "info"),
    });

    pi.on("session_start", async (_event, context) => {
      stop();
      ctx = context;
      await registerRemoteTools();
      // A print or JSON run has nobody idle to deliver to.
      if (context.mode === "print" || context.mode === "json") return;
      const created = new Inbox(hostFor(context.sessionManager.getSessionId()), deps.settings);
      inbox = created;
      await created.restore();
      const poll = setInterval(() => {
        created.tick().catch(() => undefined);
      }, deps.settings.pollMillis);
      timers.add(poll);
    });
    pi.on("session_shutdown", () => stop());
    // Runs before the turn takes its tool list, unlike agent_start.
    pi.on("before_agent_start", async (_event, context) => {
      ctx = context;
      await registerRemoteTools();
    });
    pi.on("agent_start", (_event, context) => {
      ctx = context;
      turn += 1;
      turnId = `pi-${turn}`;
      inbox?.onTurnStart(turnId);
    });
    pi.on("agent_settled", async (_event, context) => {
      ctx = context;
      const ended = turnId;
      turnId = null;
      if (ended !== null) await inbox?.onTurnComplete(ended);
    });
    pi.on("message_start", (event) => {
      if (event.message.role !== "user") return;
      const text = textOf(event.message);
      sent.find((entry) => entry.text === text)?.settle(true);
    });
  };
