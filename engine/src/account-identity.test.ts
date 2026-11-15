import { test } from "node:test";
import assert from "node:assert/strict";
import { accountEmail } from "./account-identity.js";

test("account labels accept current and legacy email layouts without depending on parentheses", () => {
  for (const label of [
    "Google Account: Person (person@example.test)",
    "Google account: Person\nperson@example.test",
    "Google Account Person <person@example.test>",
    "Google Account: Person\n\u2066person@example.test\u2069",
    "Google Account: PERSON@EXAMPLE.TEST",
  ]) assert.equal(accountEmail(label), "person@example.test");
});

test("account identity rejects missing or ambiguous emails instead of guessing", () => {
  for (const label of [null, "", "Google Account: Person", "50 credits", "person@example.test\nother@example.test"])
    assert.equal(accountEmail(label), undefined);
  assert.equal(accountEmail("person@example.test\nperson@example.test"), "person@example.test");
});
