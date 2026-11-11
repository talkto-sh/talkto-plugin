// Each plugin folder must work on its own: Claude Code copies only the plugin
// folder into its cache, and OpenCode's subfolder install and npm packages
// carry only their own folder. So every plugin carries an exact copy of the
// core sources it uses. `node core/sync.mjs` refreshes the copies; a test
// fails when one drifts.
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "src");
/** Claude Code reaches TalkTo through its own MCP client, so it needs no MCP or OAuth client. */
const delivery = ["inbox.ts", "notice.ts", "talkto.ts", "tools.ts"];
const all = [...delivery, "loopback.ts", "mcp.ts", "oauth.ts"];
export const copies = [
  { folder: join(root, "..", "claude-code", "hooks", "core"), names: delivery },
  { folder: join(root, "..", "opencode", "core"), names: all },
  { folder: join(root, "..", "pi", "core"), names: all },
];

if (process.argv[1] === fileURLToPath(import.meta.url))
  for (const copy of copies) {
    await mkdir(copy.folder, { recursive: true });
    for (const name of await readdir(copy.folder))
      if (!copy.names.includes(name)) await rm(join(copy.folder, name));
    for (const name of copy.names) await copyFile(join(source, name), join(copy.folder, name));
  }
