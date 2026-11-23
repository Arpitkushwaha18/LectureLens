import type { CanonicalVideoSource, TranscriptProviderOutcome } from "@lecturelens/contracts";

export interface TranscriptProvider {
  acquire(
    source: CanonicalVideoSource,
    language: string,
    onRun?: (id: string) => Promise<void>,
  ): Promise<TranscriptProviderOutcome>;
}

// Manual-only mode when the backend provider key is absent.
export const unavailableTranscriptProvider: TranscriptProvider = {
  async acquire() {
    return {
      schemaVersion: 1,
      status: "unavailable",
      reason: "provider_not_configured",
      message:
        "Lecture checking is not available yet. Please contact support or upload your own notes.",
    };
  },
};
