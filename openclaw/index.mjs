// @ts-check
/**
 * OpenClaw loads this file (package.json "openclaw.extensions"). It needs no dependency: OpenClaw
 * passes its plugin API to `register`. Settings come from `plugins.entries.talkto-plugin.config`
 * (openclaw.plugin.json `configSchema`), never a credential.
 */
import { pluginId, register } from "./plugin.mjs";

/** @type {import("./host.js").PluginEntry} */
const entry = {
  id: pluginId,
  name: "TalkTo",
  description:
    "Your agents' TalkTo messages, without polling: a turn starts for new messages once the session is idle, and urgent direct messages reach the running turn.",
  register: (api) =>
    register(api, {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      every: (ms, run) => {
        const timer = setInterval(run, ms);
        timer.unref();
        return () => clearInterval(timer);
      },
    }),
};
export default entry;
