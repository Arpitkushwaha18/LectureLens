import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { createApp } from "../dist/app.js";
import { createLibraryRouter } from "../dist/routes/library.routes.js";
import { StudyLibrary } from "../dist/repositories/study-library.js";

it("real gallery HTTP allows anonymous published reads, gates ownership/CSRF and persists private idempotent quiz scores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lecturelens-library-http-"));
  const library = new StudyLibrary("local_postgres", directory),
    router = Router();
  router.use(
    "/library",
    createLibraryRouter(() => library),
  );
  const server = createApp(router).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/library`;
  const request = (path, init = {}, cookie) =>
    fetch(base + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-LectureLens-Request": "1",
        ...(cookie ? { Cookie: cookie } : {}),
        ...init.headers,
      },
    });
  try {
    const aliceResponse = await request("/session", { method: "POST" }),
      alice = (await aliceResponse.json()).data;
    const aliceCookie = aliceResponse.headers.get("set-cookie").split(";")[0];
    const bobResponse = await request("/session", { method: "POST" }),
      bob = (await bobResponse.json()).data;
    const bobCookie = bobResponse.headers.get("set-cookie").split(";")[0];
    const resource = await library.save(
      alice.ownerId,
      "a".repeat(64),
      {
        outputType: "mcq_quiz",
        description: "Test quiz",
        subject: "Biology",
        language: "en",
        sourceLanguage: "en",
        sourceType: "pdf",
        preview: "Cell quiz",
      },
      {
        version: 1,
        type: "mcq_quiz",
        title: "Cell quiz",
        limitations: [],
        questions: [
          {
            id: "q1",
            question: "What contains DNA?",
            options: ["Nucleus", "Wall"],
            answerIndex: 0,
            explanation: "DNA is in the nucleus.",
            marks: 2,
          },
        ],
      },
      {
        sourceIdentity: "private:test",
        sourceHash: "b".repeat(64),
        model: "test",
        promptVersion: "test",
      },
    );
    assert.equal((await request(`/resources/${resource.id}`)).status, 404);
    assert.equal((await request(`/resources/${resource.id}`, {}, bobCookie)).status, 404);
    assert.equal((await request("/resources?scope=mine")).status, 401);
    assert.equal((await request("/resources?offset=-1")).status, 400);
    assert.equal(
      (await (await request("/resources?scope=mine", {}, aliceCookie)).json()).data.data.length,
      1,
    );
    const permission = {
      basis: "own_work",
      statement: "Original fixture",
      confirmRights: true,
      confirmPlatformTerms: true,
    };
    assert.equal(
      (
        await request(
          `/resources/${resource.id}/publish`,
          { method: "POST", body: JSON.stringify(permission) },
          bobCookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `/resources/${resource.id}/publish`,
          {
            method: "POST",
            headers: { "X-LectureLens-Request": "" },
            body: JSON.stringify(permission),
          },
          aliceCookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `/resources/${resource.id}/publish`,
          { method: "POST", body: JSON.stringify(permission) },
          aliceCookie,
        )
      ).status,
      200,
    );
    const publicResource = (await (await request(`/resources/${resource.id}`)).json()).data;
    assert.equal(publicResource.owned, false);
    assert.equal(JSON.stringify(publicResource).includes("sourceHash"), false);
    assert.equal(
      (await (await request("/resources?scope=mine", {}, bobCookie)).json()).data.data.length,
      0,
    );
    assert.equal((await (await request("/resources")).json()).data.data.length, 1);
    const submissionId = randomUUID(),
      body = JSON.stringify({ submissionId, answers: [0] });
    assert.equal(
      (await request(`/resources/${resource.id}/attempts`, { method: "POST", body })).status,
      401,
    );
    const attempt = (
      await (
        await request(`/resources/${resource.id}/attempts`, { method: "POST", body }, bobCookie)
      ).json()
    ).data;
    assert.equal(attempt.score, 2);
    assert.equal(
      (
        await (
          await request(`/resources/${resource.id}/attempts`, { method: "POST", body }, bobCookie)
        ).json()
      ).data.id,
      attempt.id,
    );
    assert.equal(
      (await (await request(`/resources/${resource.id}/attempts`, {}, aliceCookie)).json()).data
        .length,
      0,
    );
    assert.equal(
      (await (await request(`/resources/${resource.id}/attempts`, {}, bobCookie)).json()).data
        .length,
      1,
    );
    const countBefore = (
      await (await library.db()).query("select count(*) as n from ll_private.study_guest_sessions")
    ).rows[0].n;
    assert.equal(
      (await request("/resources?scope=mine", {}, `ll_session=${"x".repeat(43)}`)).status,
      401,
    );
    assert.equal(
      (
        await (
          await library.db()
        ).query("select count(*) as n from ll_private.study_guest_sessions")
      ).rows[0].n,
      countBefore,
    );
    assert.notEqual(alice.ownerId, bob.ownerId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await library.close();
    await rm(directory, { recursive: true, force: true });
  }
});
