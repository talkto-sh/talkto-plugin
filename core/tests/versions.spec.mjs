// Every plugin reports its version to TalkTo, and hosts detect updates by the version in their
// manifests (Claude Code, Codex, Gemini CLI and Antigravity only see a release when it changes).
// So each plugin's constant and every manifest it ships must say the same version. The TalkTo
// repository's tools/plugin-release.mjs sets them together.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { version as claudeCode } from "../../claude-code/hooks/version.ts";
import { version as opencode } from "../../opencode/version.ts";
import { version as pi } from "../../pi/version.ts";
import { version as openclaw } from "../../openclaw/version.mjs";
import { version as hooks } from "../../hooks/src/talkto-hook.mjs";
import { hosts } from "../../hooks/src/hosts.mjs";

const root = new URL("../../", import.meta.url);
const text = (path) => readFile(new URL(path, root), "utf8");
const manifest = async (path) => JSON.parse(await text(path)).version;

const plugins = {
  "claude-code": [
    claudeCode,
    ["claude-code/.claude-plugin/plugin.json", "claude-code/package.json"],
  ],
  opencode: [opencode, ["opencode/package.json"]],
  pi: [pi, ["pi/package.json"]],
  openclaw: [
    openclaw,
    ["openclaw/package.json", "openclaw/openclaw.plugin.json", "openclaw.plugin.json"],
  ],
  hooks: [
    hooks,
    [
      "hooks/package.json",
      "hooks/codex/.codex-plugin/plugin.json",
      "hooks/cursor/.cursor-plugin/plugin.json",
      "hooks/copilot/plugin.json",
      "hooks/gemini/gemini-extension.json",
      "hooks/gemini/plugin.json",
      "hooks/claude-format/.claude-plugin/plugin.json",
    ],
  ],
};

test("each plugin's reported version is the version in every manifest it ships", async () => {
  for (const [name, [version, manifests]] of Object.entries(plugins)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, name);
    for (const path of manifests) assert.equal(await manifest(path), version, `${name}: ${path}`);
  }
});

test("Hermes reports the version in plugin.yaml", async () => {
  const yaml = /^version: (\S+)$/m.exec(await text("hermes/plugin.yaml"))?.[1];
  const python = /^VERSION = "(\S+)"$/m.exec(await text("hermes/version.py"))?.[1];
  assert.ok(yaml !== undefined && python !== undefined);
  assert.equal(python, yaml);
});

test("the repository's own manifests are at least as new as every plugin", async () => {
  const newest = Object.values(plugins)
    .map(([version]) => version)
    .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
  for (const path of ["package.json", "core/package.json"]) {
    const version = await manifest(path);
    assert.ok(version.localeCompare(newest, "en", { numeric: true }) >= 0, path);
  }
});

test("every talkto-hooks host says how to install an update there", () => {
  for (const host of Object.values(hosts))
    assert.match(host.updateSteps, /^\S.{20,}[^.]$/, host.name);
});
