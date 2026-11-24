import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { AppError } from "../lib/errors.js";
import { PDFDocument } from "pdf-lib";

const label = z.string().trim().min(1).max(120);
export const galleryMetadataSchema = z.strictObject({
  title: z.string().trim().min(1).max(180),
  course: label,
  semester: z.coerce.number().int().min(1).max(12),
  subject: label,
  description: z.string().trim().max(1000).default(""),
  rightsConfirmed: z.literal(true),
});
export const galleryFilterSchema = z.strictObject({
  course: label.optional(),
  semester: z.coerce.number().int().min(1).max(12).optional(),
  subject: label.optional(),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
const bucket = "admin-gallery-pdfs";
const columns = "id,title,course,semester,subject,description,created_at";
export type GalleryUpload = z.infer<typeof galleryMetadataSchema>;
export function createAdminGallery(client = getSupabaseAdmin) {
  const failure = () =>
    new AppError("The notes gallery is unavailable right now. Please retry shortly.", {
      code: "GALLERY_UNAVAILABLE",
      statusCode: 503,
    });
  return {
    async list(input: unknown) {
      const filters = galleryFilterSchema.parse(input),
        db = client();
      let query = db
        .from("admin_gallery_notes")
        .select(columns)
        .order("created_at", { ascending: false })
        .order("id")
        .range(filters.offset, filters.offset + 24);
      if (filters.course) query = query.eq("course", filters.course);
      if (filters.semester) query = query.eq("semester", filters.semester);
      if (filters.subject) query = query.eq("subject", filters.subject);
      const { data, error } = await query;
      if (error) throw failure();
      return { data: (data ?? []).slice(0, 24), hasMore: (data ?? []).length > 24 };
    },
    async catalog() {
      const { data, error } = await client().rpc("admin_gallery_catalog");
      if (error) throw failure();
      return data ?? [];
    },
    async upload(input: unknown, bytes: Buffer) {
      const metadata = galleryMetadataSchema.parse(input);
      if (bytes.length > 20 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new AppError("Upload a valid PDF no larger than 20 MB.", {
          code: "GALLERY_PDF_INVALID",
          statusCode: 400,
        });
      try {
        const pdf = await PDFDocument.load(bytes);
        if (!pdf.getPageCount()) throw new Error("Empty PDF");
      } catch {
        throw new AppError("Upload a readable, unencrypted PDF.", {
          code: "GALLERY_PDF_INVALID",
          statusCode: 400,
        });
      }
      const db = client(),
        id = randomUUID(),
        objectPath = `${id}.pdf`;
      const { error: uploadError } = await db.storage
        .from(bucket)
        .upload(objectPath, bytes, { contentType: "application/pdf", upsert: false });
      if (uploadError) throw failure();
      const { title, course, semester, subject, description } = metadata;
      const fields = { title, course, semester, subject, description };
      const { data, error } = await db
        .from("admin_gallery_notes")
        .insert({ id, ...fields, object_path: objectPath })
        .select(columns)
        .single();
      if (error) {
        await db.storage.from(bucket).remove([objectPath]);
        throw failure();
      }
      return data;
    },
    async download(id: string) {
      z.uuid().parse(id);
      const db = client();
      const { data, error } = await db
        .from("admin_gallery_notes")
        .select("object_path")
        .eq("id", id)
        .maybeSingle();
      if (error) throw failure();
      if (!data)
        throw new AppError("These notes were not found.", {
          code: "GALLERY_NOT_FOUND",
          statusCode: 404,
        });
      const { data: signed, error: signError } = await db.storage
        .from(bucket)
        .createSignedUrl(data.object_path, 300);
      if (signError || !signed) throw failure();
      return signed.signedUrl;
    },
    async pdfBytes(id: string) {
      z.uuid().parse(id);
      const db = client();
      const { data, error } = await db
        .from("admin_gallery_notes")
        .select("object_path")
        .eq("id", id)
        .maybeSingle();
      if (error) throw failure();
      if (!data)
        throw new AppError("These notes were not found.", {
          code: "GALLERY_NOT_FOUND",
          statusCode: 404,
        });
      const { data: file, error: downloadError } = await db.storage
        .from(bucket)
        .download(data.object_path);
      if (downloadError || !file || file.size > 20 * 1024 * 1024) throw failure();
      return Buffer.from(await file.arrayBuffer());
    },
  };
}
