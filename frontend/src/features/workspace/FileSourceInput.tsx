import { FileCheck2, FileText, Table2, Upload, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatFileSize, type FileSourceType } from "./workspace-model";

type FileSourceInputProps = {
  source: FileSourceType;
  file: File | null;
  error: string | null;
  onSelect: (files: File[]) => void;
  onRemove: () => void;
};

export function FileSourceInput({ source, file, error, onSelect, onRemove }: FileSourceInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const id = useId();
  const isPdf = source === "pdf";
  const Icon = isPdf ? FileText : Table2;

  return (
    <div>
      <div
        className={cn(
          "rounded-lg border border-dashed px-4 py-7 text-center transition-colors sm:px-8 sm:py-8",
          dragging ? "border-navy bg-navy-soft/60" : "border-rule-strong bg-paper/50",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          onSelect(Array.from(event.dataTransfer.files));
        }}
        data-testid="file-drop-zone"
      >
        <span className="mx-auto flex size-12 items-center justify-center rounded-lg border border-rule bg-surface text-navy shadow-paper">
          <Upload className="size-5" strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h3 className="mt-3 text-lg">Drop your {isPdf ? "PDF" : "spreadsheet"} here</h3>
        <p id={`${id}-hint`} className="mt-1 text-xs leading-relaxed text-ink-muted">
          {isPdf ? "PDF" : "XLSX, XLS or CSV"} · one file · up to 20 MB
        </p>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept={isPdf ? ".pdf,application/pdf" : ".xlsx,.xls,.csv"}
          aria-label={isPdf ? "Select PDF file" : "Select Excel or CSV file"}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (files.length) onSelect(files);
            event.currentTarget.value = "";
          }}
        />
        <Button variant="secondary" className="mt-4" onClick={() => inputRef.current?.click()}>
          <Icon className="size-4" aria-hidden="true" />
          Choose {isPdf ? "PDF" : "file"}
        </Button>
        <p className="mt-3 text-[11px] text-ink-muted">
          Your file is sent only when you click Continue. It is processed temporarily, not saved to
          our database. Download your results before leaving this page.
        </p>
      </div>

      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-3 text-xs leading-relaxed text-terracotta-deep"
        >
          {error}
        </p>
      ) : null}
      {file ? (
        <div className="mt-3 flex min-w-0 items-center gap-3 rounded-md border border-olive/25 bg-olive-soft/50 p-3">
          <FileCheck2 className="size-5 shrink-0 text-olive" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium break-all text-ink">{file.name}</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {formatFileSize(file.size)} · selected locally
            </p>
          </div>
          <Button size="icon" variant="ghost" aria-label="Remove selected file" onClick={onRemove}>
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
