import test from "node:test";
import assert from "node:assert/strict";

import { greet } from "../src/index.js";

test("greet returns a default greeting", () => {
  assert.equal(greet(), "Hello, world!");
});

test("greet returns a custom greeting", () => {
  assert.equal(greet("Demonlord"), "Hello, Demonlord!");
});
