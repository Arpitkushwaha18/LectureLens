import { useEffect, useState } from "react";
import { videoVerificationSchema, parseYouTubeUrl } from "@lecturelens/contracts";
import { API_BASE_URL } from "@/lib/api";
type State = {
  url: string;
  status: "idle" | "invalid" | "checking" | "verified" | "unavailable";
  message: string;
  token?: string;
  title?: string;
};
export function useVideoVerification(url: string, enabled: boolean) {
  const [state, setState] = useState<State>({ url: "", status: "idle", message: "" });
  const [revision, setRevision] = useState(0);
  const retry = () => {
    setState({ url: "", status: "checking", message: "Checking your lecture…" });
    setRevision((v) => v + 1);
  };
  let canonical: string | undefined;
  try {
    canonical = parseYouTubeUrl(url).canonicalUrl;
  } catch {
    /* Pure immediate format check. */
  }
  useEffect(() => {
    if (!enabled || !canonical) return;
    const controller = new AbortController();
    let stale = false;
    const timer = setTimeout(() => {
      void fetch(`${API_BASE_URL}/workspace/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-LectureLens-Request": "1" },
        body: JSON.stringify({ url: canonical }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = await response.json().catch(() => null);
          if (!response.ok) {
            const messages: Record<string, string> = {
              LEARNING_SCHEMA_MISSING:
                "Lecture storage is not ready yet. Please contact support; no new transcript request was started.",
              LEARNING_STORAGE_FORBIDDEN:
                "Lecture storage needs a connection repair. Please contact support.",
              LEARNING_STORAGE_UNAVAILABLE:
                "Lecture storage could not be reached. Please try again later.",
              VIDEO_METADATA_UNAVAILABLE: "YouTube could not be reached. Please try again shortly.",
              EXTRACTION_PENDING:
                "This lecture is already being checked. Please wait a moment and check again.",
              TRANSCRIPT_NOT_CONFIGURED:
                "Lecture checking is not available yet. Please contact support.",
            };
            throw new Error(
              response.status === 429
                ? "Too many lectures are being checked right now. Please wait a minute."
                : (messages[body?.error?.code] ??
                    "We could not check this lecture safely. Please try again later."),
            );
          }
          const result = videoVerificationSchema.safeParse(body?.data);
          if (!result.success)
            throw new Error(
              "Lecture checking returned an unreadable result. Please try again later.",
            );
          return result.data;
        })
        .then((result) => {
          if (!stale)
            setState({
              url: canonical,
              status: result.status,
              message: result.message,
              token: result.verificationToken,
              title: result.title,
            });
        })
        .catch((error) => {
          if (!stale && !controller.signal.aborted)
            setState({
              url: canonical,
              status: "unavailable",
              message:
                error instanceof TypeError
                  ? "Could not connect to lecture checking. Please check your connection and try again."
                  : (error as Error).message,
            });
        });
    }, 600);
    return () => {
      stale = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [canonical, enabled, revision]);
  if (!url.trim() || !enabled) return { url, status: "idle" as const, message: "", retry };
  if (!canonical)
    return {
      url,
      status: "invalid" as const,
      message: "Please paste a valid YouTube watch, Shorts, live or youtu.be video link.",
      retry,
    };
  if (state.url !== canonical)
    return {
      url: canonical,
      status: "checking" as const,
      message: "Validating your YouTube URL…",
      retry,
    };
  return { ...state, retry };
}
