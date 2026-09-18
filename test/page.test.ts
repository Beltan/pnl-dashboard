import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { page } from "../src/page.ts";

/** The page's script ships inside a template literal and has no build step, so nothing else parses it. */
function script(): string {
  const match = page().match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "the page has an inline script");
  return match![1]!;
}

test("the inline script parses", () => {
  assert.doesNotThrow(() => vm.compileFunction(script()));
});

test("every element the script reaches for exists in the markup", () => {
  const html = page();
  // $("x") is how the script gets at the document; each one has to be in the markup above it.
  const ids = new Set([...script().matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]!));
  assert.ok(ids.size > 10, "the ids are actually being found");
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `the script reads #${id}, which the markup does not define`);
  }
});
