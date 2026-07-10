import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_NOTICE = path.join(ROOT, "NOTICE");
const PLUGIN_NOTICE = path.join(ROOT, "plugins", "antigravity", "NOTICE");

test("root and plugin NOTICE files are identical", () => {
  const rootContent = fs.readFileSync(ROOT_NOTICE, "utf8");
  const pluginContent = fs.readFileSync(PLUGIN_NOTICE, "utf8");
  assert.equal(rootContent, pluginContent);
});

test("NOTICE files include upstream attribution to OpenAI codex-plugin-cc", () => {
  const rootContent = fs.readFileSync(ROOT_NOTICE, "utf8");
  assert.match(
    rootContent,
    /This product includes software developed by OpenAI as part of codex-plugin-cc/
  );
});

test("NOTICE files retain the Apache-2.0 boilerplate", () => {
  const rootContent = fs.readFileSync(ROOT_NOTICE, "utf8");
  assert.match(rootContent, /Licensed under the Apache License, Version 2\.0/);
});
