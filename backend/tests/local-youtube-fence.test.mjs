import assert from "node:assert/strict";
import { it } from "node:test";
process.env.NODE_ENV = "test";
const { hostedJobBlocksLocalGeneration } = await import("../dist/repositories/notes.repository.js");
it("local YouTube rejects any active hosted job and unknown terminal outcome across models", () => {
  for (const status of ["queued", "retry_wait", "running"])
    for (const last_error_code of [null, "GEMINI_TEMPORARY", "GEMINI_MODEL_NOT_FOUND"])
      assert.equal(hostedJobBlocksLocalGeneration({ status, last_error_code }), true);
  for (const status of ["failed", "cancelled"])
    for (const last_error_code of [null, "GEMINI_UNCERTAIN", "unexpected"])
      assert.equal(hostedJobBlocksLocalGeneration({ status, last_error_code }), true);
  for (const status of ["failed", "cancelled"])
    assert.equal(
      hostedJobBlocksLocalGeneration({ status, last_error_code: "GEMINI_MODEL_NOT_FOUND" }),
      false,
    );
});
