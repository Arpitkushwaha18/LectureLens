import { Check, LoaderCircle } from "lucide-react";
import type { WorkspaceEvent } from "@lecturelens/contracts";

export function GenerationProgress({
  event,
  ready = false,
}: {
  event: Extract<WorkspaceEvent, { event: "stage" }>;
  ready?: boolean;
}) {
  return (
    <section
      role="status"
      aria-label="Study material processing"
      aria-live="polite"
      aria-busy={!ready}
      className="generation-progress my-6 flex items-center gap-4 rounded-xl border border-rule bg-surface p-5"
    >
      <span
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-navy/5 text-navy"
        aria-hidden="true"
      >
        {ready ? (
          <Check className="size-6" />
        ) : (
          <LoaderCircle className="size-7 animate-spin [animation-duration:1.8s] motion-reduce:animate-none" />
        )}
      </span>
      <div className="min-w-0">
        <h2 className="text-xl">{ready ? "Your notes are ready" : "Preparing your notes"}</h2>
        {!ready ? <p className="mt-1 text-sm text-ink-soft">{event.message}</p> : null}
      </div>
    </section>
  );
}
