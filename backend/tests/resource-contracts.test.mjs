import assert from "node:assert/strict";
import { it } from "node:test";
import {
  notebookToResource,
  resourceToNotebook,
  resourceContentSchema,
} from "@lecturelens/contracts";
import { notebookFixture } from "../../frontend/tests/helpers/notebook-fixture.mjs";
for (const type of [
  "detailed_notes",
  "short_notes",
  "flashcards",
  "mcq_quiz",
  "mindmap",
  "sample_question_paper",
])
  it(`normalizes and validates ${type} as a distinct versioned resource`, () => {
    const content = notebookToResource(notebookFixture, type);
    assert.equal(content.type, type);
    assert.equal(content.version, 1);
    assert.equal(resourceToNotebook(content).title, notebookFixture.title);
  });
it("rejects invalid graph references, duplicate entry IDs and invalid quiz answers", () => {
  const map = notebookToResource(notebookFixture, "mindmap");
  map.maps[0].edges[0].to = "missing";
  assert.equal(resourceContentSchema.safeParse(map).success, false);
  const quiz = notebookToResource(notebookFixture, "mcq_quiz");
  quiz.questions[0].answerIndex = 9;
  assert.equal(resourceContentSchema.safeParse(quiz).success, false);
  const deck = notebookToResource(notebookFixture, "flashcards");
  deck.cards.push(deck.cards[0]);
  assert.equal(resourceContentSchema.safeParse(deck).success, false);
});
