import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { galleryCatalog, galleryNotes } from "@/features/library/admin-gallery-api";
import { Button } from "@/components/ui/Button";
import { GalleryPdfCard } from "@/features/library/GalleryPdfCard";

export function GalleryPage() {
  const [params, setParams] = useSearchParams();
  const course = params.get("course") ?? "",
    semester = course ? (params.get("semester") ?? "") : "",
    subject = course && semester ? (params.get("subject") ?? "") : "";
  const offset = Math.max(0, Math.min(10000, Number(params.get("offset")) || 0));
  const filters = new URLSearchParams({ offset: String(offset) });
  if (course) filters.set("course", course);
  if (semester) filters.set("semester", semester);
  if (subject) filters.set("subject", subject);
  const catalog = useQuery({
    queryKey: ["admin-gallery-catalog"],
    queryFn: ({ signal }) => galleryCatalog(signal),
    retry: 1,
  });
  const notes = useQuery({
    queryKey: ["admin-gallery", filters.toString()],
    queryFn: ({ signal }) => galleryNotes(filters, signal),
    retry: 1,
  });
  const all = catalog.data ?? [];
  const courses = [...new Set(all.map((n) => n.course))].sort();
  const semesters = [
    ...new Set(all.filter((n) => course && n.course === course).map((n) => n.semester)),
  ].sort((a, b) => a - b);
  const subjects = [
    ...new Set(
      all
        .filter((n) => course && semester && n.course === course && n.semester === Number(semester))
        .map((n) => n.subject),
    ),
  ].sort();
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "offset") next.delete("offset");
    next.delete("scope");
    if (key === "course") {
      next.delete("semester");
      next.delete("subject");
    }
    if (key === "semester") next.delete("subject");
    setParams(next);
  }
  const control = "mt-2 w-full rounded border border-rule bg-surface p-3";
  return (
    <section className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="label-caps text-navy">Your course. Your semester. Your subject.</p>
          <h1 className="mt-2 text-3xl">Notes Gallery</h1>
          <p className="mt-3 max-w-xl text-sm text-ink-soft">
            Browse admin-uploaded PDF notes. Free to open and download—no account or password
            needed.
          </p>
        </div>
        <Link to="/admin" className="text-sm text-navy underline">
          Admin upload
        </Link>
      </header>
      <div className="paper-panel mb-6 grid gap-4 p-5 sm:grid-cols-3">
        <label className="text-sm">
          Course
          <select
            aria-label="Course"
            className={control}
            value={course}
            onChange={(e) => filter("course", e.target.value)}
          >
            <option value="">All courses</option>
            {courses.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Semester
          <select
            aria-label="Semester"
            className={control}
            value={semester}
            disabled={!course}
            onChange={(e) => filter("semester", e.target.value)}
          >
            <option value="">{course ? "Choose semester" : "Choose a course first"}</option>
            {semesters.map((s) => (
              <option key={s} value={s}>
                Semester {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Subject
          <select
            aria-label="Subject"
            className={control}
            value={subject}
            disabled={!course || !semester}
            onChange={(e) => filter("subject", e.target.value)}
          >
            <option value="">
              {semester ? "All subjects in this semester" : "Choose a semester first"}
            </option>
            {subjects.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      {notes.isPending || catalog.isPending ? (
        <p role="status">Loading notes…</p>
      ) : notes.error || catalog.error ? (
        <div role="alert">
          <p>{notes.error?.message ?? catalog.error?.message}</p>
          <Button
            className="mt-3"
            onClick={() => {
              void notes.refetch();
              void catalog.refetch();
            }}
          >
            Retry loading
          </Button>
        </div>
      ) : !notes.data?.data.length ? (
        <p className="paper-panel p-6">No notes have been uploaded for this selection yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {notes.data.data.map((note) => (
            <li key={note.id}>
              <GalleryPdfCard note={note} />
            </li>
          ))}
        </ul>
      )}
      <nav aria-label="Gallery pages" className="mt-6 flex justify-between gap-3">
        <Button
          variant="secondary"
          disabled={offset === 0 || notes.isFetching}
          onClick={() => filter("offset", String(Math.max(0, offset - 24)))}
        >
          Previous page
        </Button>
        <Button
          variant="secondary"
          disabled={!notes.data?.hasMore || notes.isFetching}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("offset", String(offset + 24));
            setParams(next);
          }}
        >
          Next page
        </Button>
      </nav>
    </section>
  );
}
