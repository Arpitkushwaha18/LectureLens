import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { galleryCatalog, galleryRequest } from "@/features/library/admin-gallery-api";
import { Button } from "@/components/ui/Button";

export function AdminPage() {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["gallery-admin-session"],
    queryFn: async () => Boolean((await galleryRequest("/admin/session")).data.authenticated),
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ["admin-gallery-catalog"],
    queryFn: ({ signal }) => galleryCatalog(signal),
    enabled: session.data === true,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [course, setCourse] = useState(""),
    [semester, setSemester] = useState("1"),
    [subject, setSubject] = useState("");
  const control = "mt-2 w-full rounded border border-rule bg-surface p-3";
  async function login(form: HTMLFormElement) {
    if (busy) return;
    setBusy(true);
    setError("");
    const password = String(new FormData(form).get("password"));
    form.reset();
    try {
      await galleryRequest("/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      await session.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(form: HTMLFormElement) {
    if (busy) return;
    const values = new FormData(form),
      file = values.get("file") as File;
    if (!file?.size || file.size > 20 * 1024 * 1024) {
      setError("Select a PDF no larger than 20 MB.");
      return;
    }
    const body = new FormData();
    body.set("file", file);
    body.set(
      "metadata",
      JSON.stringify({
        title: values.get("title"),
        course,
        semester: Number(semester),
        subject,
        description: values.get("description"),
        rightsConfirmed: values.get("rights") === "on",
      }),
    );
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await galleryRequest("/admin/notes", { method: "POST", body });
      form.reset();
      setCourse("");
      setSemester("1");
      setSubject("");
      setNotice("Notes uploaded. They are now publicly available in the gallery.");
      await client.invalidateQueries({ queryKey: ["admin-gallery"] });
      await catalog.refetch();
    } catch (e) {
      setError((e as Error).message);
      await session.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto max-w-2xl">
      <p className="label-caps text-navy">Admin only</p>
      <h1 className="mt-2 text-3xl">Upload gallery notes</h1>
      <p className="my-4 text-sm text-ink-soft">
        Only this upload page is password protected. Your uploaded PDFs are available to everyone.
      </p>
      <Link to="/gallery" className="text-navy underline">
        ← Notes Gallery
      </Link>
      {error || session.error ? (
        <p role="alert" className="my-4 text-terracotta">
          {error || session.error?.message}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="my-4 text-navy">
          {notice}
        </p>
      ) : null}
      {session.isPending ? (
        <p role="status" className="mt-5">
          Checking admin access…
        </p>
      ) : !session.data ? (
        <form
          className="paper-panel mt-6 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void login(e.currentTarget);
          }}
        >
          <label>
            Admin password
            <input
              className={control}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
            />
          </label>
          <Button type="submit" className="mt-4" disabled={busy}>
            {busy ? "Signing in…" : "Sign in as admin"}
          </Button>
        </form>
      ) : (
        <>
          <form
            className="paper-panel mt-6 grid gap-5 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              void upload(e.currentTarget);
            }}
          >
            <label>
              Note title
              <input className={control} name="title" required maxLength={180} />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                Course
                <input
                  aria-label="Course"
                  className={control}
                  list="course-options"
                  name="course"
                  value={course}
                  onChange={(e) => {
                    setCourse(e.target.value);
                    setSubject("");
                  }}
                  placeholder="e.g. B.Tech"
                  required
                  maxLength={120}
                />
                <datalist id="course-options">
                  {[...new Set((catalog.data ?? []).map((n) => n.course))].sort().map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </label>
              <label>
                Semester
                <select
                  aria-label="Semester"
                  className={control}
                  value={semester}
                  onChange={(e) => {
                    setSemester(e.target.value);
                    setSubject("");
                  }}
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i + 1}>
                      Semester {i + 1}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Subject
              <input
                className={control}
                list="subject-options"
                name="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={!course.trim()}
                placeholder="e.g. Data Structures"
                required
                maxLength={120}
              />
              <datalist id="subject-options">
                {[
                  ...new Set(
                    (catalog.data ?? [])
                      .filter((n) => n.course === course && n.semester === Number(semester))
                      .map((n) => n.subject),
                  ),
                ]
                  .sort()
                  .map((s) => (
                    <option key={s} value={s} />
                  ))}
              </datalist>
            </label>
            <label>
              Description (optional)
              <textarea className={control} name="description" maxLength={1000} rows={3} />
            </label>
            <label>
              PDF notes
              <input
                className={control}
                name="file"
                type="file"
                accept="application/pdf,.pdf"
                required
              />
              <span className="text-xs text-ink-muted">
                Readable, unencrypted PDF · maximum 20 MB
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input className="mt-1" type="checkbox" name="rights" required />I have permission to
              share this PDF publicly.
            </label>
            <Button type="submit" disabled={busy}>
              {busy ? "Uploading…" : "Upload notes to gallery"}
            </Button>
          </form>
          <Button
            className="mt-4"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void galleryRequest("/admin/logout", { method: "POST" })
                .then(() => {
                  client.setQueryData(["gallery-admin-session"], false);
                  setNotice("");
                })
                .catch((e) => setError(e.message));
            }}
          >
            Sign out of admin
          </Button>
        </>
      )}
    </section>
  );
}
