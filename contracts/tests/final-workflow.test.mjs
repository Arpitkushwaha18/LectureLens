import assert from "node:assert/strict";
import { it } from "node:test";
import {
  flashcardCountSchema,
  quizCountSchema,
  parseYouTubeUrl,
  workspaceEventSchema,
} from "../dist/index.js";
it("count selectors enforce integer bounds and default ten", () => {
  for (const [schema, max] of [
    [flashcardCountSchema, 20],
    [quizCountSchema, 30],
  ]) {
    assert.equal(schema.parse(undefined), 10);
    for (const n of [5, max]) assert.equal(schema.parse(n), n);
    for (const n of [4, max + 1, 5.5, "10", null]) assert.equal(schema.safeParse(n).success, false);
  }
});
it("live recordings normalize to canonical video IDs and progress is bounded", () => {
  assert.equal(
    parseYouTubeUrl("https://www.youtube.com/live/AbCdEf12_-3?si=tracking").canonicalUrl,
    "https://www.youtube.com/watch?v=AbCdEf12_-3",
  );
  for (const percent of [0, 40, 100])
    assert.ok(
      workspaceEventSchema.safeParse({
        event: "progress",
        percent,
        message: "Actual completed stage",
      }).success,
    );
  for (const percent of [-1, 101, 2.5])
    assert.equal(
      workspaceEventSchema.safeParse({ event: "progress", percent, message: "Invalid" }).success,
      false,
    );
});
