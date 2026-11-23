import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_LOCAL_FILE_BYTES,
  formatFileSize,
  getYouTubeSource,
  isWorkspaceReady,
  validateLocalFile,
} from "../.cache/workspace-tests/features/workspace/workspace-model.js";

const url = "https://youtu.be/AbCdEf12_-3?t=30";
const pdf = { name: "selection-fixture.pdf", type: "application/pdf", size: 1024 };

describe("Local-only workspace file selection", () => {
  const valid = [
    ["PDF", pdf, "pdf"],
    ["uppercase PDF extension", { ...pdf, name: "selection-fixture.PDF" }, "pdf"],
    [
      "XLSX",
      {
        name: "selection-fixture.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 10,
      },
      "spreadsheet",
    ],
    [
      "XLS",
      { name: "selection-fixture.xls", type: "application/vnd.ms-excel", size: 10 },
      "spreadsheet",
    ],
    ["CSV", { name: "selection-fixture.csv", type: "text/csv", size: 10 }, "spreadsheet"],
    [
      "CSV browser MIME alias",
      { name: "selection-fixture.csv", type: "application/vnd.ms-excel", size: 10 },
      "spreadsheet",
    ],
    ["MIME parameters", { ...pdf, type: "application/pdf; charset=binary" }, "pdf"],
  ];
  for (const [label, file, source] of valid) {
    it(`accepts ${label}`, () => assert.equal(validateLocalFile(file, source), null));
  }

  const invalid = [
    ["wrong extension", { ...pdf, name: "selection-fixture.exe" }, "pdf"],
    ["mismatched PDF MIME", { ...pdf, type: "text/plain" }, "pdf"],
    ["missing MIME", { ...pdf, type: "" }, "pdf"],
    ["missing extension", { ...pdf, name: "selection-fixture" }, "pdf"],
    ["double extension", { ...pdf, name: "selection-fixture.pdf.exe" }, "pdf"],
    [
      "wrong spreadsheet MIME",
      { name: "selection-fixture.xlsx", type: "application/pdf", size: 10 },
      "spreadsheet",
    ],
    ["PDF in spreadsheet mode", pdf, "spreadsheet"],
    ["empty file", { ...pdf, size: 0 }, "pdf"],
    ["negative size", { ...pdf, size: -1 }, "pdf"],
    ["fractional size", { ...pdf, size: 1.5 }, "pdf"],
    ["too large", { ...pdf, size: MAX_LOCAL_FILE_BYTES + 1 }, "pdf"],
  ];
  for (const [label, file, source] of invalid) {
    it(`rejects ${label}`, () => assert.equal(typeof validateLocalFile(file, source), "string"));
  }
  it("accepts exactly 20 MiB", () =>
    assert.equal(validateLocalFile({ ...pdf, size: MAX_LOCAL_FILE_BYTES }, "pdf"), null));
  it("formats filename metadata sizes without reading file contents", () => {
    assert.equal(formatFileSize(10), "10 B");
    assert.equal(formatFileSize(1024), "1.0 KB");
    assert.equal(formatFileSize(1024 * 1024), "1.0 MB");
  });
});

describe("Workspace readiness and canonical URL handling", () => {
  it("uses B1 validation and canonicalizes timestamped links", () => {
    assert.equal(getYouTubeSource(url).canonicalUrl, "https://www.youtube.com/watch?v=AbCdEf12_-3");
    assert.equal(getYouTubeSource("https://youtube.com.evil.test/watch?v=AbCdEf12_-3"), null);
  });
  it("requires a valid URL and one or more outputs", () => {
    assert.equal(isWorkspaceReady("youtube", url, null, []), false);
    assert.equal(isWorkspaceReady("youtube", "invalid", null, ["mindmap"]), false);
    assert.equal(isWorkspaceReady("youtube", url, null, ["mindmap"]), true);
    assert.equal(
      isWorkspaceReady("youtube", url, null, ["mindmap", "sample_question_paper"]),
      true,
    );
  });
  it("requires a valid local file and outputs in file mode", () => {
    assert.equal(isWorkspaceReady("pdf", url, null, ["flashcards"]), false);
    assert.equal(isWorkspaceReady("pdf", url, pdf, []), false);
    assert.equal(isWorkspaceReady("pdf", "", pdf, ["flashcards"]), true);
    assert.equal(
      isWorkspaceReady("pdf", "", { ...pdf, type: "text/plain" }, ["flashcards"]),
      false,
    );
  });
  it("does not reuse a valid YouTube URL to enable an empty file source", () => {
    assert.equal(isWorkspaceReady("spreadsheet", url, null, ["short_notes"]), false);
  });
  it("rejects duplicate selections and actual PYQ types", () => {
    assert.equal(isWorkspaceReady("youtube", url, null, ["mindmap", "mindmap"]), false);
    assert.equal(isWorkspaceReady("youtube", url, null, ["actual_pyq"]), false);
  });
});
