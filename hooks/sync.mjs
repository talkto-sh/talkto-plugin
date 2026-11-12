// Each host folder must work on its own: plugin installs copy only that folder. So every folder
// carries an exact copy of the hook scripts (and the skill, where the host loads skills).
// `node hooks/sync.mjs` refreshes the copies; a test fails when one drifts.
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const scripts = ["core.mjs", "hosts.mjs", "talkto-hook.mjs"];
/** Host folders, and whether the host loads a bundled `skills/` folder. */
export const folders = [
  { name: "claude-format", skill: true },
  { name: "codex", skill: true },
  { name: "cursor", skill: true },
  { name: "copilot", skill: true },
  { name: "gemini", skill: true },
];
export const source = { scripts: join(root, "src"), skill: join(root, "skill", "SKILL.md") };
export const scriptFolder = (name) => join(root, name, "scripts");
/** Other plugins that reuse the signal-link core: the OpenClaw plugin reads the same links. */
export const coreCopies = [{ folder: join(root, "..", "openclaw", "core"), names: ["core.mjs"] }];
export const skillFile = (name) => join(root, name, "skills", "talkto-signal", "SKILL.md");

if (process.argv[1] === fileURLToPath(import.meta.url))
  for (const folder of folders) {
    const target = scriptFolder(folder.name);
    await mkdir(target, { recursive: true });
    for (const name of await readdir(target))
      if (!scripts.includes(name)) await rm(join(target, name));
    for (const name of scripts) await copyFile(join(source.scripts, name), join(target, name));
    if (folder.skill) {
      await mkdir(dirname(skillFile(folder.name)), { recursive: true });
      await copyFile(source.skill, skillFile(folder.name));
    }
  }
if (process.argv[1] === fileURLToPath(import.meta.url))
  for (const copy of coreCopies) {
    await mkdir(copy.folder, { recursive: true });
    for (const name of await readdir(copy.folder))
      if (!copy.names.includes(name)) await rm(join(copy.folder, name));
    for (const name of copy.names)
      await copyFile(join(source.scripts, name), join(copy.folder, name));
  }
