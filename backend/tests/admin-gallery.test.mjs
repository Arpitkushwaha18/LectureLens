import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Router } from "express";
import { textPdf } from "./helpers/documents.mjs";
import { galleryClientFixture } from "./helpers/admin-gallery-client.mjs";
process.env.GALLERY_ADMIN_PASSWORD = "synthetic-test-admin-password-only";
process.env.LOG_LEVEL = "silent";
const { createAdminGallery } = await import("../dist/repositories/admin-gallery.js");
const { createAdminGalleryRouter } = await import("../dist/routes/admin-gallery.routes.js");
const { createApp } = await import("../dist/app.js");

it("admin gallery migration keeps direct visitor DB writes locked and stores only note metadata", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); grant usage on schema public to service_role;",
    );
    await db.exec(
      await readFile(
        new URL("../../supabase/migrations/20261123001700_admin_pdf_gallery.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.exec(
      "set role service_role; insert into public.admin_gallery_notes(id,title,course,semester,subject,object_path) values('11111111-1111-4111-8111-111111111111','Transactions','B.Tech',3,'DBMS','11111111-1111-4111-8111-111111111111.pdf');",
    );
    assert.equal(
      (await db.query("select public.admin_gallery_catalog() as value")).rows[0].value[0].course,
      "B.Tech",
    );
    await db.exec("reset role; set role anon;");
    await assert.rejects(() => db.query("select * from public.admin_gallery_notes"));
    await assert.rejects(() => db.query("select public.admin_gallery_catalog()"));
  } finally {
    await db.close();
  }
});
it("public downloads need no password; upload requires admin cookie, header, PDF and rights; failed inserts clean only their own object", async () => {
  const fixture = galleryClientFixture(),
    gallery = createAdminGallery(() => fixture.client);
  const router = Router();
  router.use("/gallery", createAdminGalleryRouter(gallery));
  const server = createApp(router).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api/v1/gallery`;
  const metadata = {
    title: "Transactions",
    course: "B.Tech",
    semester: 3,
    subject: "DBMS",
    description: "Test",
    rightsConfirmed: true,
  };
  const pdf = await textPdf();
  function body(bytes = pdf, details = metadata) {
    const form = new FormData();
    form.set("metadata", JSON.stringify(details));
    form.set("file", new Blob([bytes], { type: "application/pdf" }), "notes.pdf");
    return form;
  }
  try {
    assert.equal((await fetch(`${origin}/notes`)).status, 200);
    assert.equal(
      (
        await fetch(`${origin}/admin/notes`, {
          method: "POST",
          headers: { "X-LectureLens-Request": "1" },
          body: body(),
        })
      ).status,
      401,
    );
    const credentials = {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LectureLens-Request": "1" },
      body: JSON.stringify({ password: process.env.GALLERY_ADMIN_PASSWORD }),
    };
    assert.equal(
      (
        await fetch(`${origin}/admin/login`, {
          ...credentials,
          body: JSON.stringify({ password: "wrong" }),
        })
      ).status,
      401,
    );
    const login = await fetch(`${origin}/admin/login`, credentials);
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { Cookie: cookie, "X-LectureLens-Request": "1" };
    assert.equal(
      (
        await fetch(`${origin}/admin/notes`, {
          method: "POST",
          headers: { Cookie: cookie },
          body: body(),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/admin/notes`, {
          method: "POST",
          headers,
          body: body(Buffer.from("not pdf")),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${origin}/admin/notes`, {
          method: "POST",
          headers,
          body: body(pdf, { ...metadata, rightsConfirmed: false }),
        })
      ).status,
      400,
    );
    const uploaded = await fetch(`${origin}/admin/notes`, {
      method: "POST",
      headers,
      body: body(),
    });
    assert.equal(uploaded.status, 201);
    const note = (await uploaded.json()).data;
    assert.equal(
      (await (await fetch(`${origin}/notes?course=B.Tech&semester=3&subject=DBMS`)).json()).data
        .length,
      1,
    );
    assert.equal((await (await fetch(`${origin}/notes?course=BCA`)).json()).data.length, 0);
    const download = await fetch(`${origin}/notes/${note.id}/pdf`, { redirect: "manual" });
    assert.equal(download.status, 302);
    assert.match(download.headers.get("location"), /fixture.invalid/);
    const preview = await fetch(`${origin}/notes/${note.id}/preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type"), /image\/png/);
    assert.equal(preview.headers.get("cross-origin-resource-policy"), "cross-origin");
    const image = Buffer.from(await preview.arrayBuffer());
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(image.readUInt32BE(16) <= 560);
    assert.ok(image.readUInt32BE(20) <= 1000);
    assert.equal(
      (await fetch(`${origin}/notes/11111111-1111-4111-8111-111111111111/preview`)).status,
      404,
    );
    assert.equal(fixture.files.size, 1); // previews never create a second storage object
    fixture.setFailInsert(true);
    await assert.rejects(() => gallery.upload(metadata, pdf));
    assert.equal(fixture.files.size, 1);
    assert.equal(fixture.rows.length, 1);
    assert.equal(fixture.rows[0].owner_id, undefined);
    assert.equal(
      (await fetch(`${origin}/admin/session`, { headers: { Cookie: cookie + "0" } })).status,
      200,
    );
    assert.equal(
      (await (await fetch(`${origin}/admin/session`, { headers: { Cookie: cookie + "0" } })).json())
        .data.authenticated,
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
