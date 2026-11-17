/**
 * OpenCode 2 loads this module (package.json "exports"). Configuration comes
 * from the environment, never a credential:
 * - TALKTO_MCP_URL: TalkTo's MCP URL (default https://talkto.sh/mcp)
 * - TALKTO_WAIT: always (default) or never; auto, the default before 0.3.4, means always
 * - TALKTO_URGENT: inject (default) or queue
 * - TALKTO_POLL_SECONDS: 5 to 300 (default 15)
 */
import { waitPolicyOf, type Settings } from "./core/inbox.ts";
import { plugin } from "./plugin.ts";

const env = process.env;
const seconds = Number(env["TALKTO_POLL_SECONDS"] ?? 15);
const settings: Settings = {
  delivery: "idle",
  urgent: env["TALKTO_URGENT"] === "queue" ? "queue" : "inject",
  pollMillis: Math.max(5, Math.min(300, Number.isFinite(seconds) ? seconds : 15)) * 1000,
  wait: waitPolicyOf(env["TALKTO_WAIT"]),
};

export default plugin({
  mcpUrl: env["TALKTO_MCP_URL"] ?? "https://talkto.sh/mcp",
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  settings,
});
