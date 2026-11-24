import { useState } from "react";
import { FileText, ArrowUpRight } from "lucide-react";
import { type GalleryNote, galleryPdfUrl } from "./admin-gallery-api";

export function GalleryPdfCard({ note }: { note: GalleryNote }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = galleryPdfUrl(note.id);
  return (
    <article className="h-full overflow-hidden rounded-xl border border-rule bg-surface shadow-sm">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Preview ${note.title} PDF`}
        className="block border-b border-rule bg-white"
      >
        {failed ? (
          <div className="flex h-28 items-center justify-center gap-2 bg-paper px-3 text-ink-muted">
            <FileText size={24} aria-hidden="true" />
            <span className="text-xs">Preview unavailable · open the PDF below</span>
          </div>
        ) : (
          <img
            src={`${url.replace(/\/pdf$/, "/preview")}${attempt ? `?retry=${attempt}` : ""}`}
            alt={`First page of ${note.title}`}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-28 w-full object-cover object-top"
          />
        )}
        <div className="flex items-center gap-2 bg-paper px-3 py-2">
          <FileText size={18} className="shrink-0 text-terracotta" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-ink">{note.title}</span>
            <span className="text-[10px] text-ink-muted">PDF · first-page preview</span>
          </span>
        </div>
      </a>
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-sm font-medium text-navy" title={note.subject}>
            {note.subject}
          </h2>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-navy underline underline-offset-4"
          >
            Open / download PDF <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        </div>
        <p className="mt-1 text-[11px] text-ink-muted">
          {note.course} <span aria-hidden="true">›</span> Semester {note.semester}
        </p>
        {note.description ? (
          <p className="mt-1 line-clamp-1 text-xs text-ink-soft" title={note.description}>
            {note.description}
          </p>
        ) : null}
        {failed ? (
          <button
            type="button"
            className="mt-2 text-xs text-navy underline"
            onClick={() => {
              setAttempt((value) => value + 1);
              setFailed(false);
            }}
          >
            Retry preview
          </button>
        ) : null}
      </div>
    </article>
  );
}
