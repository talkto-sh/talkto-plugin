// Every host folder installs on its own, so each carries copies that must match the source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { folders, scriptFolder, scripts, skillFile, source } from "../sync.mjs";

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
