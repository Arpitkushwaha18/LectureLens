import { workspaceEventSchema, type WorkspaceEvent } from "@lecturelens/contracts";

export async function processSource(
  baseUrl: string,
  options: unknown,
  file: File | null,
  signal: AbortSignal,
  onEvent: (event: WorkspaceEvent) => void,
) {
  const body = new FormData();
  body.append("options", JSON.stringify(options));
  if (file) body.append("file", file);
  const response = await fetch(`${baseUrl}/workspace/process`, {
    method: "POST",
    credentials: "omit",
    headers: { "X-LectureLens-Request": "1" },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
    cache: "no-store",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    if ([400, 413, 429].includes(response.status)) {
      onEvent(
        workspaceEventSchema.parse({
          event: "error",
          code: error?.error?.code ?? "WORKSPACE_REQUEST_REJECTED",
          message: error?.error?.message ?? "Your request was not started. You can try again.",
          retryable: true,
          ...(response.status === 429
            ? {
                retryAfterSeconds: Math.max(
                  1,
                  Math.min(86400, Number(response.headers.get("retry-after")) || 60),
                ),
              }
            : {}),
        }),
      );
      return;
    }
    throw new Error(error?.error?.message || `Backend request failed (${response.status}).`);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson"))
    throw new Error("Backend did not return a processing stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    completed = false,
    total = 0;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = workspaceEventSchema.parse(JSON.parse(line));
    if (event.event === "result" || event.event === "error") completed = true;
    onEvent(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
        break;
      }
      total += value.length;
      if (total > 2000000) throw new Error("Backend response exceeds safe display limits.");
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    if (!completed)
      throw new Error(
        "The connection ended before processing completed. Your completed materials remain on this page; retry the missing outputs.",
      );
  } finally {
    await reader.cancel();
  }
}
