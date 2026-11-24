import { API_BASE_URL } from "@/lib/api";
import { z } from "zod";
export async function libraryRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE_URL}/library${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "X-LectureLens-Request": "1",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error?.message ??
        (response.status === 429
          ? "Too many study requests. Please wait a minute and try again."
          : "Your study library is unavailable. Please retry."),
    );
  if (!body) throw new Error("The study library returned an invalid response. Please retry.");
  return body;
}
export const sessionSchema = z.object({
  data: z.object({
    ownerId: z.uuid().nullable(),
    storage: z.enum(["supabase", "local_postgres"]),
    mode: z.enum(["guest", "account"]),
  }),
});
let session: Promise<z.infer<typeof sessionSchema>["data"]> | null = null;
let expires = 0;
export async function openStudySession(refresh = false) {
  if (refresh || !session || Date.now() > expires) {
    expires = Date.now() + 60000;
    const pending = libraryRequest("/session", { method: "POST" })
      .then((body) => sessionSchema.parse(body).data)
      .catch((error) => {
        if (session === pending) session = null;
        throw error;
      });
    session = pending;
  }
  return session;
}
