/**
 * pi loads this file (package.json "pi.extensions"). Configuration comes from
 * the environment, never a credential:
 * - TALKTO_MCP_URL: TalkTo's MCP URL (default https://talkto.sh/mcp)
 * - TALKTO_WAIT: always (default) or never; auto, the default before 0.3.4, means always
 * - TALKTO_URGENT: inject (default) or queue
 * - TALKTO_POLL_SECONDS: 5 to 300 (default 15)
 * - TALKTO_CHANNEL_BATCH_MINUTES and TALKTO_CACHE_MINUTES: when channel messages that do not concern
 *   the agent are summarized on their own (see `hostTimings` in core/inbox.ts for the defaults)
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { minutesSetting, waitPolicyOf, type Settings } from "./core/inbox.ts";
import { extension } from "./extension.ts";

const env = process.env;
const seconds = Number(env["TALKTO_POLL_SECONDS"] ?? 15);
const settings: Settings = {
  delivery: "idle",
  urgent: env["TALKTO_URGENT"] === "queue" ? "queue" : "inject",
  pollMillis: Math.max(5, Math.min(300, Number.isFinite(seconds) ? seconds : 15)) * 1000,
  wait: waitPolicyOf(env["TALKTO_WAIT"]),
  channelBatchMillis: minutesSetting(env["TALKTO_CHANNEL_BATCH_MINUTES"]),
  cacheMillis: minutesSetting(env["TALKTO_CACHE_MINUTES"]),
};
const agentDir = env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");

export default extension({
  mcpUrl: env["TALKTO_MCP_URL"] ?? "https://talkto.sh/mcp",
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  stateDir: join(agentDir, "talkto-plugin"),
  settings,
});
