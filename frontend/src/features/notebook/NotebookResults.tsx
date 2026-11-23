import { createPortal } from "react-dom";
import { useState } from "react";
import type { WorkspaceResult } from "@lecturelens/contracts";
import { Button } from "@/components/ui/Button";
import { Notebook } from "./Notebook";
import { API_BASE_URL } from "@/lib/api";
import { notebookToResource } from "@lecturelens/contracts";
import { ResourceExperience } from "@/features/resources/ResourceExperience";
import { resourceLabels } from "@/features/resources/resource-labels";

export function NotebookResults({
  result,
}: {
  result: Extract<WorkspaceResult, { status: "ready" }>;
}) {
  const [printing, setPrinting] = useState(false);
  const [selected, setSelected] = useState(result.materials[0]!.outputType);
  const current = result.materials.find((m) => m.outputType === selected) ?? result.materials[0]!;
  const [error, setError] = useState<string | null>(null);
  async function exportPdf() {
    setPrinting(true);
    setError(null);
    try {
      await document.fonts.ready;
      const root = document.getElementById("notebook-print-root");
      if (!root) throw new Error("Notebook is unavailable");
      const response = await fetch(`${API_BASE_URL}/workspace/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: root.innerHTML }),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error("PDF export failed");
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement("a");
      link.href = url;
      link.download = "lecturelens-notebook.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError(
        "PDF download is unavailable. Please retry. You can also use your browser's Print → Save as PDF.",
      );
    } finally {
      setPrinting(false);
    }
  }
  const notebooks = result.materials.map((material, i) => (
    <section key={i} className="material-section">
      <p className="material-label">
        {material.outputType.replaceAll("_", " ")} ·{" "}
        {material.cached ? "Reused notes" : "Prepared for you"}
      </p>
      <Notebook notebook={material.notebook} sourceName={result.source.name} />
    </section>
  ));
  return (
    <section className="mt-6" aria-label="Generated study material">
      <div className="result-toolbar mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl">Your study set is ready</h2>
        <Button onClick={() => void exportPdf()} disabled={printing}>
          {printing ? "Preparing PDF…" : "Export PDF"}
        </Button>
      </div>
      <p className="mb-4 text-xs text-ink-muted">
        Download an A4 PDF with all selected materials, diagrams and answers.
      </p>
      {error ? <p role="alert">{error}</p> : null}
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
      <ResourceExperience
        key={current.outputType}
        content={notebookToResource(current.notebook, current.outputType)}
        sourceName={result.source.name}
      />
      {createPortal(<div id="notebook-print-root">{notebooks}</div>, document.body)}
    </section>
  );
}
