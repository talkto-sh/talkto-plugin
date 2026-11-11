// Every plugin folder must carry exactly the core sources it uses (see sync.mjs).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { copies } from "../sync.mjs";

const source = new URL("../src/", import.meta.url).pathname;

for (const copy of copies)
  test(`${copy.folder.split("/").slice(-3).join("/")} carries the current core`, async () => {
    assert.deepEqual(
      (await readdir(copy.folder)).sort(),
      [...copy.names].sort(),
      "run: node core/sync.mjs",
    );
    for (const name of copy.names)
      assert.equal(
        await readFile(join(copy.folder, name), "utf8"),
        await readFile(join(source, name), "utf8"),
        `${name} differs; run: node core/sync.mjs`,
      );
  });
