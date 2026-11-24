import { createPortal } from "react-dom";
import { useState } from "react";
import type { WorkspaceResult, ResourceContent } from "@lecturelens/contracts";
import { Button } from "@/components/ui/Button";
import { Notebook } from "./Notebook";
import { API_BASE_URL } from "@/lib/api";
import { notebookToResource } from "@lecturelens/contracts";
import { ResourceExperience } from "@/features/resources/ResourceExperience";
import { resourceLabels } from "@/features/resources/resource-labels";

export function NotebookResults({
  result,
  content,
}: {
  result: Extract<WorkspaceResult, { status: "ready" }>;
  content?: ResourceContent;
}) {
  const [printing, setPrinting] = useState(false);
  const [selected, setSelected] = useState(result.materials[0]!.outputType);
  const current = result.materials.find((m) => m.outputType === selected) ?? result.materials[0]!;
  const [error, setError] = useState<string | null>(null);
  async function printPdf() {
    setPrinting(true);
    try {
      // Print-only content is normally hidden, so explicitly load its exact faces.
      await Promise.all([
        document.fonts.load('400 16px "Kalam"'),
        document.fonts.load('700 16px "Kalam"'),
        document.fonts.load('400 24px "Caveat"'),
        document.fonts.load('700 36px "Caveat"'),
        document.fonts.load('400 18px "STIX Two Math"'),
      ]);
      await document.fonts.ready;
      window.print();
    } catch {
      setError("Print fonts could not load. Please retry before saving your PDF.");
    } finally {
      setPrinting(false);
    }
  }
  async function exportPdf() {
    setPrinting(true);
    setError(null);
    try {
      await document.fonts.ready;
      const root = document.getElementById("notebook-print-root");
      if (!root) throw new Error("Notebook is unavailable");
      const response = await fetch(`${API_BASE_URL}/workspace/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-LectureLens-Request": "1" },
        body: JSON.stringify({ html: root.innerHTML }),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const code = body?.error?.code;
        if (code === "PDF_BUSY" || response.status === 429)
          throw new Error(
            "PDF export is busy. Wait a moment and retry, or use Print / Save as PDF.",
          );
        if (code === "PDF_EXPORT_FAILED")
          throw new Error(
            "The server could not prepare the PDF. Use Print / Save as PDF, or retry after the backend is updated.",
          );
        throw new Error("PDF download is unavailable. Retry or use Print / Save as PDF.");
      }
      const blob = await response.blob();
      if (
        !response.headers.get("content-type")?.includes("application/pdf") ||
        (await blob.slice(0, 5).text()) !== "%PDF-"
      )
        throw new Error("The server did not return a valid PDF. Use Print / Save as PDF or retry.");
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "lecturelens-notebook.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(
        failure instanceof Error &&
          (failure.message.startsWith("PDF") || failure.message.startsWith("The server"))
          ? failure.message
          : "PDF download is unavailable. Please retry or use Print / Save as PDF.",
      );
    } finally {
      setPrinting(false);
    }
  }
  const notebooks = result.materials.map((material, i) => (
    <section key={i} className="material-section">
      <p className="material-label">{material.outputType.replaceAll("_", " ")}</p>
      <Notebook notebook={material.notebook} sourceName={result.source.name} notesOnly />
    </section>
  ));
  return (
    <section className="mt-6" aria-label="Generated study material">
      <div className="result-toolbar mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl">
          {result.completionStatus === "partially_completed"
            ? "Your completed materials"
            : "Your study set is ready"}
        </h2>
        <Button onClick={() => void exportPdf()} disabled={printing}>
          {printing ? "Preparing PDF…" : "Export PDF"}
        </Button>
      </div>
      <p className="mb-4 text-xs text-ink-muted">
        Download an A4 PDF with all selected materials, diagrams and answers.
      </p>
      {error ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm">
            {error}
          </p>
          <Button variant="secondary" disabled={printing} onClick={() => void printPdf()}>
            Print / Save as PDF
          </Button>
        </div>
      ) : null}
      <div className="resource-overview" role="tablist" aria-label="Learning resources">
        {result.materials.map((m) => (
          <button
            key={m.outputType}
            className="resource-tab"
            type="button"
            role="tab"
            aria-selected={current.outputType === m.outputType}
            onClick={() => setSelected(m.outputType)}
          >
            <strong>{resourceLabels[m.outputType]}</strong>
            <span>{m.cached ? "Reused · ready" : "Prepared · ready"}</span>
          </button>
        ))}
      </div>
      {result.materials.map((material) => (
        <div
          key={material.resourceId ?? material.outputType}
          hidden={current.outputType !== material.outputType}
          role="tabpanel"
          aria-label={resourceLabels[material.outputType]}
        >
          <ResourceExperience
            content={
              content?.type === material.outputType
                ? content
                : notebookToResource(material.notebook, material.outputType)
            }
            sourceName={result.source.name}
            resourceId={material.resourceId}
          />
        </div>
      ))}
      {createPortal(<div id="notebook-print-root">{notebooks}</div>, document.body)}
    </section>
  );
}
