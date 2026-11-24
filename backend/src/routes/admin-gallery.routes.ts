import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { createAdminGallery } from "../repositories/admin-gallery.js";
import {
  adminLogin,
  adminLogout,
  isGalleryAdmin,
  requireGalleryAdmin,
} from "../services/admin-session.js";
import { requireStudyRequest } from "../services/study-session.js";
import { apiRateLimit } from "../middleware/rate-limit.js";
import { AppError } from "../lib/errors.js";
import { galleryPreview } from "../services/gallery-preview.service.js";

export function createAdminGalleryRouter(gallery = createAdminGallery()) {
  const router = Router();
  router.get("/catalog", async (_req, res) => res.json({ data: await gallery.catalog() }));
  router.get("/notes", async (req, res) => res.json(await gallery.list(req.query)));
  router.get("/notes/:id/pdf", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, await gallery.download(req.params.id));
  });
  router.get("/notes/:id/preview", apiRateLimit(60), async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const image = await galleryPreview(() => gallery.pdfBytes(id));
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Public gallery images must be embeddable by the separately hosted frontend.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.type("image/png").send(image);
  });
  router.get("/admin/session", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { authenticated: isGalleryAdmin(req) } });
  });
  router.post("/admin/login", apiRateLimit(5), (req, res) => {
    requireStudyRequest(req);
    const { password } = z.strictObject({ password: z.string().min(1).max(4096) }).parse(req.body);
    adminLogin(password, res);
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: { authenticated: true } });
  });
  router.post("/admin/logout", (req, res) => {
    requireStudyRequest(req);
    adminLogout(res);
    res.json({ data: { authenticated: false } });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 1, fieldSize: 5000, parts: 2 },
  }).single("file");
  router.post(
    "/admin/notes",
    apiRateLimit(10),
    (req, _res, next) => {
      requireStudyRequest(req);
      requireGalleryAdmin(req);
      next();
    },
    (req, res, next) =>
      upload(req, res, (error) =>
        next(
          error
            ? new AppError("Upload one PDF no larger than 20 MB.", {
                code: "GALLERY_PDF_INVALID",
                statusCode: 400,
              })
            : undefined,
        ),
      ),
    async (req, res) => {
      if (!req.file)
        throw new AppError("Select a PDF to upload.", {
          code: "GALLERY_PDF_INVALID",
          statusCode: 400,
        });
      let metadata: unknown;
      try {
        metadata = JSON.parse(req.body.metadata ?? "{}");
      } catch {
        throw new AppError("Check the note details.", {
          code: "GALLERY_METADATA_INVALID",
          statusCode: 400,
        });
      }
      res.status(201).json({ data: await gallery.upload(metadata, req.file.buffer) });
    },
  );
  return router;
}
