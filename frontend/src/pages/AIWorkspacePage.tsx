import { ArrowRight, Check, ClipboardPaste } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { flashcardCountSchema, quizCountSchema } from "@lecturelens/contracts";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { FileSourceInput } from "@/features/workspace/FileSourceInput";
import { useWorkspaceRun } from "@/features/workspace/useWorkspaceRun";
import { GenerationProgress } from "@/features/workspace/GenerationProgress";
import { SourcePreview } from "@/features/workspace/SourcePreview";
import { NotebookResults } from "@/features/notebook/NotebookResults";
import { useVideoVerification } from "@/features/workspace/useVideoVerification";
import { TutorSearchBar } from "@/features/workspace/TutorSearchBar";
import {
  formatFileSize,
  getYouTubeSource,
  isWorkspaceReady,
  validateLocalFile,
  type FileSourceType,
  type WorkspaceSourceType,
} from "@/features/workspace/workspace-model";
import { workspaceOutputs, workspaceSources } from "@/features/workspace/workspace-options";
import { cn } from "@/lib/cn";
import type { GenerationOutputTypeV2 } from "@/lib/learning-contracts";

export function AIWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sourceParam = searchParams.get("source");
  const source: WorkspaceSourceType =
    sourceParam === "pdf" || sourceParam === "spreadsheet" ? sourceParam : "youtube";
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [files, setFiles] = useState<Record<FileSourceType, File | null>>({
    pdf: null,
    spreadsheet: null,
  });
  const [fileErrors, setFileErrors] = useState<Record<FileSourceType, string | null>>({
    pdf: null,
    spreadsheet: null,
  });
  const [outputs, setOutputs] = useState<GenerationOutputTypeV2[]>([]);
  const [flashcardCount, setFlashcardCount] = useState(10);
  const [quizCount, setQuizCount] = useState(10);
  const [clipboardMessage, setClipboardMessage] = useState<string | null>(null);
  const run = useWorkspaceRun();
  const youtubeSource = getYouTubeSource(url);
  const verification = useVideoVerification(url, source === "youtube");
  const [subject, setSubject] = useState("");
  const urlFieldRef = useRef<HTMLDivElement>(null);
  const selectedFile = source === "youtube" ? null : files[source];
  const ready =
    isWorkspaceReady(source, url, selectedFile, outputs) &&
    (source !== "youtube" || verification.status === "verified") &&
    flashcardCountSchema.safeParse(flashcardCount).success &&
    quizCountSchema.safeParse(quizCount).success;
  const selectedOutputs = workspaceOutputs.filter((output) => outputs.includes(output.id));
  const sourceLabel = workspaceSources.find((item) => item.id === source)?.label;

  async function pasteLink() {
    run.reset();
    try {
      if (!navigator.clipboard?.readText || !window.isSecureContext)
        throw new Error("Clipboard unavailable");
      const text = await navigator.clipboard.readText();
      setUrl(text);
      setUrlTouched(true);
      setClipboardMessage(
        text.trim() ? null : "Your clipboard is empty. Copy a YouTube link or paste it below.",
      );
    } catch {
      setClipboardMessage(
        "Clipboard access isn't available. Paste your link directly into the URL field.",
      );
    }
    urlFieldRef.current?.querySelector("input")?.focus();
  }

  function selectFiles(sourceType: FileSourceType, selection: File[]) {
    const file = selection[0] ?? null;
    const error =
      selection.length !== 1
        ? "Choose one file at a time."
        : file
          ? validateLocalFile(file, sourceType)
          : "Choose a file.";
    setFiles((current) => ({ ...current, [sourceType]: error ? null : file }));
    setFileErrors((current) => ({ ...current, [sourceType]: error }));
    run.reset();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready)
      void run.start(
        {
          sourceType: source,
          ...(source === "youtube" ? { url, verificationToken: verification.token } : {}),
          outputTypes: outputs,
          flashcardCount,
          quizCount,
          ...(subject.trim() ? { subject: subject.trim() } : {}),
        },
        selectedFile,
      );
  }

  return (
    <>
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 text-center sm:mb-10">
          <div className="mb-4 inline-flex items-center gap-2 text-navy">
            <span className="urtutor-mascot" aria-hidden="true">
              ⌒‿⌒
            </span>
            <span className="label-caps text-navy">UrTutor · your friendly study companion</span>
          </div>
          <h1 className="text-[1.9rem] leading-[1.18] sm:text-[2.7rem] sm:leading-[1.15]">
            Learn anything. <span className="text-navy">Prepare smarter.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-soft sm:text-[15px]">
            Bring your lectures, documents and question banks into one workspace. Choose how you
            want to learn — from deeper notes to smarter revision.
          </p>
          <p className="margin-note mt-3 text-sm">Your material. Your way of learning.</p>
          <p className="mt-3 text-xs text-ink-muted">
            No account or saved history. Download your study set before leaving or refreshing;
            generated work is not added to the Notes Gallery.
          </p>
          <TutorSearchBar />
        </header>

        <form onSubmit={submit}>
          <fieldset disabled={run.busy} className="min-w-0">
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper/60 px-5 py-3 sm:px-7">
                <p className="label-caps text-[10px]">A new page in your notebook</p>
                <Badge dashed className="text-[9px]">
                  Your source → your notebook
                </Badge>
              </div>

              <div className="p-4 xs:p-5 sm:p-7">
                <fieldset>
                  <legend className="mb-4 flex items-center gap-3">
                    <span className="font-serif text-xl italic text-terracotta">01</span>
                    <span className="text-sm font-semibold">Start with your material</span>
                  </legend>
                  <div className="grid grid-cols-3 gap-2 sm:gap-3">
                    {workspaceSources.map(({ id, label, icon: Icon }) => (
                      <label
                        key={id}
                        className={cn(
                          "relative flex min-w-0 cursor-pointer flex-col items-center gap-2 rounded-md border px-2 py-4 text-center transition-colors sm:flex-row sm:gap-3 sm:px-4 sm:text-left",
                          source === id
                            ? "border-navy/60 bg-navy-soft/45"
                            : "border-rule bg-surface hover:border-rule-strong hover:bg-paper/50",
                        )}
                      >
                        <input
                          type="radio"
                          name="learning-source"
                          value={id}
                          checked={source === id}
                          className="peer sr-only"
                          onChange={() => {
                            setSearchParams({ source: id }, { replace: true });
                            run.reset();
                          }}
                        />
                        <span
                          className="absolute inset-0 rounded-md peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-navy"
                          aria-hidden="true"
                        />
                        <Icon
                          className="size-5 shrink-0 text-navy"
                          strokeWidth={1.6}
                          aria-hidden="true"
                        />
                        <span className="text-[11px] leading-snug font-medium sm:text-[13px]">
                          {label}
                        </span>
                        {source === id ? (
                          <Check
                            className="absolute top-1.5 right-1.5 size-3 text-navy sm:hidden"
                            aria-hidden="true"
                          />
                        ) : null}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="mt-5 rounded-lg border border-rule/80 bg-surface p-4 sm:mt-6 sm:p-5">
                  {source === "youtube" ? (
                    <div>
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs leading-relaxed text-ink-muted">
                          A lecture link is all you need to start your selection.
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="px-2"
                          onClick={() => void pasteLink()}
                        >
                          <ClipboardPaste className="size-3.5" aria-hidden="true" />
                          Paste link
                        </Button>
                      </div>
                      <div ref={urlFieldRef}>
                        <Input
                          label="YouTube URL"
                          type="url"
                          inputMode="url"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="https://www.youtube.com/watch?v=…"
                          value={url}
                          onChange={(event) => {
                            setUrl(event.target.value);
                            setClipboardMessage(null);
                            run.reset();
                          }}
                          onBlur={() => setUrlTouched(true)}
                          hint="Supports YouTube watch links, youtu.be, Shorts and recorded live videos."
                          error={
                            (urlTouched || url.length > 0) && !youtubeSource && url.length > 0
                              ? "Use a valid HTTPS YouTube watch, youtu.be, Shorts or embed link."
                              : undefined
                          }
                        />
                      </div>
                      {clipboardMessage ? (
                        <p role="status" className="mt-2 text-xs leading-relaxed text-ink-soft">
                          {clipboardMessage}
                        </p>
                      ) : null}
                      {url.trim() ? (
                        <p
                          role="status"
                          className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-olive"
                        >
                          <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                          <span>
                            {verification.message}
                            {verification.status === "verified" && verification.title
                              ? ` · ${verification.title}`
                              : ""}
                          </span>
                        </p>
                      ) : null}
                      {verification.status === "unavailable" ||
                      verification.status === "verified" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={verification.retry}
                        >
                          Check lecture again
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <FileSourceInput
                      key={source}
                      source={source}
                      file={files[source]}
                      error={fileErrors[source]}
                      onSelect={(selection) => selectFiles(source, selection)}
                      onRemove={() => {
                        setFiles((current) => ({ ...current, [source]: null }));
                        setFileErrors((current) => ({ ...current, [source]: null }));
                        run.reset();
                      }}
                    />
                  )}
                </div>

                <fieldset className="mt-7 border-t border-rule pt-6 sm:mt-8">
                  <label className="mb-5 block text-xs text-ink-soft">
                    Subject or topic (optional · your label, not AI classification)
                    <input
                      className="mt-2 block w-full rounded-md border border-rule bg-surface p-3"
                      maxLength={180}
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="e.g. Biology · Cell structure"
                    />
                  </label>
                  <legend className="float-left mb-1 flex w-full items-center gap-3">
                    <span className="font-serif text-xl italic text-terracotta">02</span>
                    <span className="text-sm font-semibold">Make it your study set</span>
                  </legend>
                  <p className="clear-both mb-4 text-xs text-ink-muted">
                    Choose one or more materials you would like to prepare.
                  </p>
                  <div className="grid grid-cols-1 gap-3 xs:grid-cols-2 sm:grid-cols-3">
                    {workspaceOutputs.map(({ id, label, description, icon: Icon }) => {
                      const selected = outputs.includes(id);
                      return (
                        <Card
                          key={id}
                          className={cn(
                            "shadow-none transition-colors",
                            selected
                              ? "border-navy/55 bg-navy-soft/30"
                              : "hover:border-rule-strong",
                          )}
                        >
                          <label className="block h-full cursor-pointer p-4">
                            <div className="mb-3 flex items-center justify-between gap-2">
                              <Icon
                                className="size-[19px] text-navy"
                                strokeWidth={1.5}
                                aria-hidden="true"
                              />
                              <input
                                type="checkbox"
                                value={id}
                                checked={selected}
                                aria-label={label}
                                className="size-4 shrink-0 accent-navy"
                                onChange={(event) => {
                                  setOutputs((current) =>
                                    event.target.checked
                                      ? [...current, id]
                                      : current.filter((type) => type !== id),
                                  );
                                  run.reset();
                                }}
                              />
                            </div>
                            <span className="block text-[13px] leading-snug font-semibold text-ink">
                              {label}
                            </span>
                            <span className="mt-1.5 block text-[11.5px] leading-relaxed text-ink-muted">
                              {description}
                            </span>
                          </label>
                        </Card>
                      );
                    })}
                  </div>
                  {outputs.includes("flashcards") ? (
                    <label className="mt-4 block text-sm">
                      Number of flashcards
                      <select
                        aria-label="Number of flashcards"
                        className="ml-3 rounded-md border border-rule bg-surface p-2"
                        value={flashcardCount}
                        onChange={(event) => {
                          setFlashcardCount(Number(event.target.value));
                          run.reset();
                        }}
                      >
                        {Array.from({ length: 16 }, (_, i) => i + 5).map((count) => (
                          <option key={count} value={count}>
                            {count}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {outputs.includes("mcq_quiz") ? (
                    <label className="mt-4 block text-sm">
                      Number of quiz questions
                      <select
                        aria-label="Number of quiz questions"
                        className="ml-3 rounded-md border border-rule bg-surface p-2"
                        value={quizCount}
                        onChange={(event) => {
                          setQuizCount(Number(event.target.value));
                          run.reset();
                        }}
                      >
                        {Array.from({ length: 26 }, (_, i) => i + 5).map((count) => (
                          <option key={count} value={count}>
                            {count}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </fieldset>
              </div>

              <div className="border-t border-rule bg-paper/60 p-4 xs:p-5 sm:p-7">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="label-caps text-[10px]">Your learning plan</p>
                    <p className="mt-2 text-xs leading-relaxed break-all text-ink-soft">
                      <span className="font-semibold">{sourceLabel}</span>
                      {source === "youtube"
                        ? youtubeSource
                          ? ` · ${youtubeSource.videoId}`
                          : " · add a valid link"
                        : selectedFile
                          ? ` · ${selectedFile.name} · ${formatFileSize(selectedFile.size)}`
                          : " · choose a file"}
                    </p>
                    {selectedOutputs.length ? (
                      <ul
                        aria-label="Selected learning materials"
                        className="mt-2 flex flex-wrap gap-1.5"
                      >
                        {selectedOutputs.map((output) => (
                          <li
                            key={output.id}
                            className="rounded-xs border border-navy/15 bg-surface px-2 py-1 text-[10.5px] text-navy"
                          >
                            {output.label}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-ink-muted">
                        No learning materials selected yet.
                      </p>
                    )}
                  </div>
                  <Button
                    type="submit"
                    disabled={
                      !ready ||
                      run.busy ||
                      Boolean(run.error?.blocked) ||
                      (run.error?.retryable && run.retryAfterSeconds > 0) ||
                      (run.result?.status === "pending" &&
                        (run.result.retrySafe !== true || run.retryAfterSeconds > 0))
                    }
                    className="min-h-11 w-full shrink-0 sm:w-auto"
                  >
                    {run.busy ? "Processing…" : "Continue"}{" "}
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </Card>
          </fieldset>
        </form>
        {run.stage && (run.busy || run.progress === 100) ? (
          <GenerationProgress event={run.stage} ready={!run.busy && run.progress === 100} />
        ) : null}
        {Object.keys(run.outputStates).length ? (
          <ul className="output-progress" aria-label="Output progress">
            {selectedOutputs.map((o) => (
              <li key={o.id} data-status={run.outputStates[o.id] ?? "queued"}>
                {o.label} · {run.outputStates[o.id] ?? "queued"}
              </li>
            ))}
          </ul>
        ) : null}
        {run.busy && ["extracting", "validating"].includes(run.stage?.stage ?? "") ? (
          <Button type="button" onClick={run.cancel}>
            Cancel reading
          </Button>
        ) : null}
        {run.error ? (
          <div role="alert" className="my-5 border-l-4 border-terracotta bg-terracotta-soft p-4">
            <h2 className="text-xl">
              {run.materials.length
                ? "Some materials need another attempt."
                : "We couldn’t prepare your study materials."}
            </h2>
            <p className="mt-2 text-sm">{run.error.message}</p>
            {run.error.retryable && run.retryAfterSeconds === 0 ? (
              <div className="mt-2">
                <Button type="button" onClick={run.retry} disabled={run.busy}>
                  Retry
                </Button>
              </div>
            ) : run.error.retryable ? (
              <p className="mt-2 text-sm">Please try again later.</p>
            ) : run.error.blocked ? (
              <Button type="button" className="mt-2" onClick={run.check} disabled={run.busy}>
                Check result
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="mt-2 px-0"
              onClick={run.dismissFailure}
            >
              Dismiss this attempt
            </Button>
          </div>
        ) : null}
        {run.result?.status === "pending" ? (
          <div role="status" className="my-5 border-l-4 border-navy p-4">
            <p>{run.result.message}</p>
            {run.result.retrySafe === true ? (
              <p className="mt-2 text-sm">
                {run.retryAfterSeconds > 0 ? (
                  "Please try again later."
                ) : (
                  <Button type="button" onClick={run.retry} disabled={run.busy}>
                    Retry
                  </Button>
                )}
              </p>
            ) : (
              <p className="mt-2 text-sm">
                <Button type="button" onClick={run.check} disabled={run.busy}>
                  Check result
                </Button>
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              className="mt-2 px-0"
              onClick={run.dismissFailure}
            >
              Dismiss this attempt
            </Button>
          </div>
        ) : null}
        {run.source ? <SourcePreview source={run.source} /> : null}
        {run.result?.status === "extracted" ? (
          <section role="status" className="my-5">
            <p>{run.result.message}</p>
            {run.source &&
            run.source.kind !== "youtube" &&
            (run.source.pages?.some((page) => page.text.trim()) ||
              run.source.sheets?.some((sheet) =>
                [
                  ...sheet.headers,
                  ...sheet.rows.flat(),
                  ...(sheet.images ?? []).map((image) => image.text),
                ].some((text) => text.trim()),
              )) ? (
              <Button
                type="button"
                onClick={() =>
                  void run.start(
                    {
                      sourceType: source,
                      outputTypes: selectedOutputs.map((output) => output.id),
                      allowPartial: true,
                      flashcardCount,
                      quizCount,
                    },
                    selectedFile,
                  )
                }
              >
                Use successfully extracted content
              </Button>
            ) : null}
            {run.result.retryable ? (
              <p>
                Click Continue to retry unreadable pages or images; successful content is reused.
              </p>
            ) : null}
          </section>
        ) : null}
        {run.materials.length && run.source ? (
          <NotebookResults
            result={
              run.result?.status === "ready"
                ? run.result
                : { status: "ready", source: run.source, materials: run.materials }
            }
          />
        ) : null}
        <footer
          data-workspace-footer
          className="mt-5 text-center text-[11px] leading-relaxed text-ink-muted"
        >
          Built for curious minds, across subjects and disciplines.
        </footer>
      </div>
    </>
  );
}
