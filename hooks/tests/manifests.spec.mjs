// Each host finds the hooks through its own manifest, and each hook command finds the script
// from the plugin's own folder, wherever the host runs it from.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = dirname(root);
/** @param {string} path */
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
/** @param {string} path */
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
/**
 * The command of every handler in a Claude-style hooks file (Codex): event → groups → hooks.
 * @param {Record<string, Array<{ hooks: Array<{ command: string }> }>>} events
 */
const groupedCommands = (events) =>
  Object.values(events).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
/**
 * The command of every handler in an Antigravity hook group: event → handlers.
 * @param {Record<string, Array<{ command: string }>>} events
 */
const flatCommands = (events) =>
  Object.values(events).flatMap((handlers) => handlers.map((handler) => handler.command));

test("Codex: the plugin has .codex-plugin/plugin.json, which declares the hooks and the skill", async () => {
  const folder = join(root, "codex");
  const manifest = await json(join(folder, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.name, "talkto-hooks");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.hooks, "./hooks/hooks.json");
  assert.equal(manifest.skills, "./skills/");
  assert.ok(await exists(join(folder, manifest.hooks)));
  assert.ok(await exists(join(folder, manifest.skills, "talkto-signal", "SKILL.md")));
  // codex-cli 0.165.0 prefers a root plugin.json and then loads none of the hooks.
  assert.equal(await exists(join(folder, "plugin.json")), false);
});

test("Codex: the marketplace lists the folder that holds the Codex manifest", async () => {
  const marketplace = await json(join(repository, ".agents", "plugins", "marketplace.json"));
  const entry = marketplace.plugins.find(
    (/** @type {{ name: string }} */ p) => p.name === "talkto-hooks",
  );
  assert.ok(entry);
  assert.ok(await exists(join(repository, entry.source.path, ".codex-plugin", "plugin.json")));
});

test("Codex: every hook command runs the plugin's own script through PLUGIN_ROOT", async () => {
  const found = groupedCommands((await json(join(root, "codex", "hooks", "hooks.json"))).hooks);
  assert.equal(found.length, 4);
  for (const command of found)
    assert.match(command, /^node "\$\{PLUGIN_ROOT\}\/scripts\/talkto-hook\.mjs" codex /);
});

test("Antigravity: every hook command is rooted at the plugin folder, not the working directory", async () => {
  const found = flatCommands((await json(join(root, "gemini", "hooks.json"))).talkto);
  assert.equal(found.length, 3);
  for (const command of found)
    assert.match(command, /^node "\$\{PLUGIN_ROOT:-\.\}\/scripts\/talkto-hook\.mjs" antigravity /);
});

test(
  "Antigravity: the session-start command works from a workspace outside the plugin",
  { skip: process.platform === "win32" && "Antigravity runs hook commands with a POSIX shell" },
  async (t) => {
    const plugin = join(root, "gemini");
    const workspace = await mkdtemp(join(tmpdir(), "talkto-workspace-"));
    const state = await mkdtemp(join(tmpdir(), "talkto-state-"));
    t.after(() =>
      Promise.all([rm(workspace, { recursive: true }), rm(state, { recursive: true })]),
    );
    const hooks = await json(join(plugin, "hooks.json"));
    const command = hooks.talkto.SessionStart[0].command;
    const input = JSON.stringify({ conversationId: "c1", workspacePaths: [workspace] });
    /** @param {string} cwd @param {Record<string, string>} extra */
    const run = (cwd, extra) =>
      spawnSync("/bin/sh", ["-c", command], {
        cwd,
        input,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", TALKTO_HOOKS_STATE_DIR: state, ...extra },
      });
    // As agy 1.5.7 runs it: PLUGIN_ROOT set, the working directory anywhere.
    const fromWorkspace = run(workspace, { PLUGIN_ROOT: plugin });
    assert.equal(fromWorkspace.stderr, "");
    assert.match(fromWorkspace.stdout, /TalkTo hooks are installed/);
    // As Antigravity's docs describe it: no PLUGIN_ROOT, the plugin folder as working directory.
    const fromPlugin = run(plugin, {});
    assert.equal(fromPlugin.stderr, "");
    assert.match(fromPlugin.stdout, /TalkTo hooks are installed/);
  },
);
