import {
  apiErrorSchema,
  createApiSuccessSchema,
  notesOutcomeSchema,
  notesRequestSchema,
  type NotesOutcome,
} from "@lecturelens/contracts";

export async function requestDetailedNotes(
  baseUrl: string,
  input: unknown,
  signal: AbortSignal,
): Promise<NotesOutcome> {
  const request = notesRequestSchema.parse(input);
  const response = await fetch(`${baseUrl}/youtube/detailed-notes`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.any([signal, AbortSignal.timeout(360_000)]),
    cache: "no-store",
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body);
    throw new Error(
      error.success ? error.data.error.message : `Notes request failed (HTTP ${response.status}).`,
    );
  }
  const parsed = createApiSuccessSchema(notesOutcomeSchema).safeParse(body);
  if (!parsed.success) throw new Error("The backend returned an invalid notes response.");
  return parsed.data.data;
}
