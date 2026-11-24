import { z } from "zod";
import { API_BASE_URL } from "@/lib/api";
export const galleryNoteSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  course: z.string(),
  semester: z.number().int(),
  subject: z.string(),
  description: z.string(),
  created_at: z.string(),
});
export type GalleryNote = z.infer<typeof galleryNoteSchema>;
export const catalogSchema = z.array(
  z.object({ course: z.string(), semester: z.number().int(), subject: z.string() }),
);
export async function galleryRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE_URL}/gallery${path}`, {
    ...init,
    credentials: "include",
    headers: { "X-LectureLens-Request": "1", ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body?.error?.message ?? "The gallery could not be reached. Please retry.");
  return body;
}
export async function galleryCatalog(signal?: AbortSignal) {
  return catalogSchema.parse((await galleryRequest("/catalog", { signal })).data);
}
export async function galleryNotes(params: URLSearchParams, signal?: AbortSignal) {
  return z
    .object({ data: z.array(galleryNoteSchema), hasMore: z.boolean() })
    .parse(await galleryRequest(`/notes?${params}`, { signal }));
}
export const galleryPdfUrl = (id: string) =>
  `${API_BASE_URL}/gallery/notes/${encodeURIComponent(id)}/pdf`;
