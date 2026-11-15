import assert from "node:assert/strict";
import { test } from "node:test";
import { creativeGuideAvailable, creativeGuideInfo, readCreativeGuide } from "./creative-guide.js";

// The guide's content is checked by the owner's private tests; these run everywhere.
test("an unknown stage is refused", () => {
  assert.throws(() => readCreativeGuide("edit" as never), /Choose ideas, plan or storyboard/);
});

test("without the guide, opening a plan still works and reading the guide says what is missing", { skip: creativeGuideAvailable() ? "the guide is present here" : false }, () => {
  assert.equal(creativeGuideInfo().revision, null);
  assert.throws(() => readCreativeGuide("ideas"), /Owner creative guide not found/);
});
