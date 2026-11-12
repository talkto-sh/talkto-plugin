// Every host folder installs on its own, so each carries copies that must match the source.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { coreCopies, folders, scriptFolder, scripts, skillFile, source } from "../sync.mjs";

test("host folders carry exact copies of the scripts and the skill (run `node sync.mjs`)", async () => {
  const skill = await readFile(source.skill, "utf8");
  for (const folder of folders) {
    for (const name of scripts)
      assert.equal(
        await readFile(join(scriptFolder(folder.name), name), "utf8"),
        await readFile(join(source.scripts, name), "utf8"),
        `${folder.name}/scripts/${name} is stale`,
      );
    if (folder.skill)
      assert.equal(
        await readFile(skillFile(folder.name), "utf8"),
        skill,
        `${folder.name} skill is stale`,
      );
  }
});

test("plugins that reuse the signal-link core carry an exact copy (run `node sync.mjs`)", async () => {
  for (const copy of coreCopies) {
    assert.deepEqual((await readdir(copy.folder)).sort(), [...copy.names].sort());
    for (const name of copy.names)
      assert.equal(
        await readFile(join(copy.folder, name), "utf8"),
        await readFile(join(source.scripts, name), "utf8"),
        `${copy.folder}/${name} is stale`,
      );
  }
});
