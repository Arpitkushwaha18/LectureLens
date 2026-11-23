import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StudyLibrary } from "../dist/repositories/study-library.js";
it("persists normalized resources, isolates private content, enforces rights, deduplicates publications and saves private scored attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lecturelens-library-"));
  let store = new StudyLibrary("local_postgres", directory);
  const alice = randomUUID(),
    bob = randomUUID(),
    key = "a".repeat(64);
  const content = {
    version: 1,
    type: "mcq_quiz",
    title: "Cell biology",
    limitations: [],
    questions: [
      {
        id: "q1",
        question: "What contains DNA?",
        options: ["Nucleus", "Wall"],
        answerIndex: 0,
        explanation: "DNA is found in the nucleus.",
        marks: 2,
      },
    ],
  };
  const meta = {
    outputType: "mcq_quiz",
    description: "A cell biology quiz",
    subject: "Biology",
    language: "en",
    sourceLanguage: "en",
    sourceType: "pdf",
    preview: "What contains DNA?",
  };
  const provenance = {
    sourceIdentity: "private:fixture",
    sourceHash: "b".repeat(64),
    model: "synthetic-test-only",
    promptVersion: "test-v1",
  };
  await store.ready();
  const own = await store.save(alice, key, meta, content, provenance);
  assert.equal(own.visibility, "private");
  assert.deepEqual(own.content, content);
  assert.equal(await store.read(own.id, bob), null);
  assert.equal(await store.find(key, bob), null);
  assert.equal((await store.list(null, {})).data.length, 0);
  const db = await store.db();
  await db.transaction(async (tx) => {
    await tx.exec("set local role anon");
    assert.equal((await tx.query("select * from public.study_resources")).rows.length, 0);
  });
  await assert.rejects(() =>
    db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await tx.query("select public.study_read($1,$2)", [own.id, alice]);
    }),
  );
  await db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [alice]);
    await tx.exec("set local role authenticated");
    assert.equal((await tx.query("select * from public.study_resources")).rows.length, 1);
    assert.equal((await tx.query("select * from public.study_resource_entries")).rows.length, 1);
  });
  await assert.rejects(() =>
    store.publish(own.id, bob, {
      basis: "own_work",
      statement: "My work",
      confirmRights: true,
      confirmPlatformTerms: true,
    }),
  );
  await assert.rejects(() =>
    store.publish(own.id, alice, {
      basis: "own_work",
      statement: "My work",
      confirmRights: false,
      confirmPlatformTerms: true,
    }),
  );
  const second = await store.save(bob, key, meta, content, provenance);
  assert.notEqual(second.id, own.id);
  const published = await store.publish(own.id, alice, {
    basis: "own_work",
    statement: "My original cell biology work",
    confirmRights: true,
    confirmPlatformTerms: true,
  });
  assert.equal(published.visibility, "published");
  assert.equal((await store.read(own.id, bob)).owned, false);
  assert.equal(
    (
      await store.publish(second.id, bob, {
        basis: "own_work",
        statement: "My work",
        confirmRights: true,
        confirmPlatformTerms: true,
      })
    ).id,
    own.id,
  );
  assert.equal((await store.save(bob, key, meta, content, provenance)).id, own.id);
  assert.equal(
    (await store.list(null, { search: "biology", outputType: "mcq_quiz" })).data.length,
    1,
  );
  const submission = randomUUID();
  const attempt = await store.submitQuiz(own.id, bob, submission, [0]);
  assert.equal(attempt.score, 2);
  assert.equal(attempt.percentage, 100);
  assert.equal((await store.submitQuiz(own.id, bob, submission, [1])).id, attempt.id);
  assert.equal((await store.attempts(own.id, alice)).length, 0);
  await db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [alice]);
    await tx.exec("set local role authenticated");
    assert.equal((await tx.query("select * from public.study_quiz_attempts")).rows.length, 0);
  });
  await assert.rejects(() => store.submitQuiz(own.id, bob, randomUUID(), [2]));
  await store.close();
  store = new StudyLibrary("local_postgres", directory);
  assert.equal((await store.read(own.id, null)).visibility, "published");
  assert.equal((await store.attempts(own.id, bob)).length, 1);
  await store.remove(
    own.id,
    "test-operator",
    "Removed on explicit rights-holder request for this test.",
  );
  assert.equal(await store.read(own.id, null), null);
  await assert.rejects(() => store.find(key, bob));
  await assert.rejects(() =>
    store.publish(second.id, bob, {
      basis: "own_work",
      statement: "Test publishing attempt after takedown",
      confirmRights: true,
      confirmPlatformTerms: true,
    }),
  );
  await store.close();
});
