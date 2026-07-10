import test from "node:test";
import assert from "node:assert/strict";

import { splitRawArgumentString } from "../plugins/antigravity/scripts/lib/args.mjs";

test("splitRawArgumentString keeps Windows-style backslashes literal", () => {
  assert.deepEqual(splitRawArgumentString("C:\\Users\\x"), ["C:\\Users\\x"]);
});

test("splitRawArgumentString still lets a backslash escape a quote", () => {
  assert.deepEqual(splitRawArgumentString('a\\"b'), ['a"b']);
});

test("splitRawArgumentString treats a trailing backslash as literal", () => {
  assert.deepEqual(splitRawArgumentString("foo\\"), ["foo\\"]);
});

test("splitRawArgumentString collapses an escaped double backslash to one literal backslash", () => {
  assert.deepEqual(splitRawArgumentString("\\\\"), ["\\"]);
});

test("splitRawArgumentString lets a backslash escape a literal space inside a token", () => {
  assert.deepEqual(splitRawArgumentString("a\\ b"), ["a b"]);
});

test("splitRawArgumentString lets a backslash escape another backslash mid-token", () => {
  assert.deepEqual(splitRawArgumentString("a\\\\b"), ["a\\b"]);
});
