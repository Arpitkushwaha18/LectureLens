import type { PublicSource } from "@lecturelens/contracts";

export function SourcePreview({ source }: { source: PublicSource }) {
  if (source.kind === "youtube")
    return (
      <p className="mt-4 text-xs text-ink-muted">
        Lecture source · {source.name}
        {source.language ? ` · ${source.language}` : ""}
      </p>
    );
  return (
    <details className="source-preview mt-5 border-y border-rule py-3">
      <summary className="cursor-pointer text-sm font-semibold">
        View your source · {source.name}
      </summary>
      {source.warnings.map((warning, i) => (
        <p key={i} className="mt-2 text-sm text-terracotta-deep">
          {warning}
        </p>
      ))}
      <div className="mt-3 max-h-96 overflow-auto">
        {source.failedImages?.map((failed, i) => (
          <p key={`image-${i}`} role="note" className="my-2 text-sm text-terracotta-deep">
            Worksheet {failed.sheet}, image {failed.name}
            {failed.location ? ` (${failed.location})` : ""}: {failed.reason}
          </p>
        ))}
        {source.failedPages?.map((failed) => (
          <p key={failed.page} role="note" className="my-2 text-sm text-terracotta-deep">
            Page {failed.page} could not be fully read: {failed.reason}
            {failed.retryable ? " · Retry available" : ""}
          </p>
        ))}
        {source.sheets ? (
          source.sheets.map((sheet, i) => (
            <section key={i} className="mb-5">
              <h3>{sheet.name}</h3>
              {!sheet.headers.length ? (
                <p>No cell data</p>
              ) : (
                <table className="source-table">
                  <thead>
                    <tr>
                      {sheet.headers.map((cell, j) => (
                        <th key={j}>{cell || `Column ${j + 1}`}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {sheet.images?.map((image, j) => (
                <aside key={j} className="mt-3">
                  <h4>
                    OCR-derived image · {image.name}
                    {image.location ? ` · ${image.location}` : ""}
                  </h4>
                  <p className="whitespace-pre-wrap text-sm">{image.text}</p>
                </aside>
              ))}
            </section>
          ))
        ) : source.pages ? (
          source.pages.map((page) => (
            <section key={page.page} className="mb-4">
              <h3>
                Page {page.page}
                {page.ocr ? " · OCR-derived text" : ""}
              </h3>
              <p className="whitespace-pre-wrap text-sm">{page.text || "No readable text"}</p>
            </section>
          ))
        ) : (
          <p className="whitespace-pre-wrap text-sm">{source.text}</p>
        )}
      </div>
    </details>
  );
}
