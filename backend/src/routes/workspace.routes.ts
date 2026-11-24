import { Router, type RequestHandler } from "express";
import multer from "multer";
import { apiRateLimit } from "../middleware/rate-limit.js";
import { ZodError } from "zod";
import { workspaceEventSchema } from "@lecturelens/contracts";
import { videoVerifier } from "../services/video-verification.js";
import {
  processTemporaryWorkspace as processWorkspace,
  askTemporaryTutor,
} from "../services/temporary-workspace.service.js";
import { MAX_UPLOAD_BYTES } from "../modules/extraction/documents.js";
import type { WorkspaceCache } from "../repositories/workspace-cache.js";
import { AppError } from "../lib/errors.js";
import { NotesGenerationError } from "../modules/ai/gemini-notes.js";
import { studentGenerationFailure } from "../modules/ai/generation-lifecycle.js";
import { z } from "zod";
import { generateNotebookPdf } from "../services/notebook-pdf.service.js";
import { type StudyLibrary } from "../repositories/study-library.js";
import { requireStudyRequest } from "../services/study-session.js";

export function createWorkspaceRouter(
  process = processWorkspace,
  _historicalGallery?: () => ReturnType<WorkspaceCache["gallery"]>,
  requestsPerMinute = 20,
  _libraryOverride?: () => StudyLibrary,
  verificationOverride: typeof videoVerifier = videoVerifier,
  tutorOverride: (input: unknown, ownerId?: string) => Promise<unknown> = askTemporaryTutor,
) {
  const router = Router();
  router.post("/ask", apiRateLimit(6), async (req, res) => {
    requireStudyRequest(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: await tutorOverride(req.body) });
  });
  router.post("/verify", apiRateLimit(12), async (req, res) => {
    requireStudyRequest(req);
    res.setHeader("Cache-Control", "no-store");
    const { url } = z.strictObject({ url: z.string().max(2048) }).parse(req.body);
    res.json({ data: await verificationOverride.verify(url) });
  });
  router.post("/export", apiRateLimit(10), async (req, res, next) => {
    try {
      requireStudyRequest(req);
      const { html } = z.strictObject({ html: z.string().min(1).max(1000000) }).parse(req.body);
      const pdf = await generateNotebookPdf(html);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", 'attachment; filename="lecturelens-notebook.pdf"');
      res.type("application/pdf").send(pdf);
    } catch (error) {
      next(error);
    }
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, fieldSize: 10000, parts: 2 },
  }).single("file");
  let active = 0;
  const handler: RequestHandler = async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", disconnect);
    const send = (event: unknown) => {
      if (!res.destroyed) res.write(JSON.stringify(workspaceEventSchema.parse(event)) + "\n");
    };
    try {
      let options: unknown;
      try {
        options = JSON.parse(req.body.options ?? "{}");
      } catch {
        throw new AppError("Invalid source options.", { code: "SOURCE_INVALID", statusCode: 400 });
      }
      const result = await process(options, req.file, send, controller.signal);
      send({ event: "result", result });
    } catch (error) {
      send({
        event: "error",
        code:
          error instanceof AppError
            ? error.code
            : error instanceof ZodError
              ? "SOURCE_INVALID"
              : "WORKSPACE_FAILED",
        message:
          error instanceof NotesGenerationError
            ? studentGenerationFailure(error.code).message
            : error instanceof AppError
              ? error.message
              : error instanceof ZodError
                ? "Invalid source or selection. Check the YouTube URL, file and selected outputs."
                : "Processing could not be completed. Please retry.",
        retryable:
          error instanceof NotesGenerationError
            ? studentGenerationFailure(error.code).retryable
            : error instanceof ZodError ||
              (error instanceof AppError &&
                [
                  "FILE_EXTRACTION",
                  "FILE_TYPE",
                  "FILE_REQUIRED",
                  "FILE_SIZE",
                  "FILE_TIMEOUT",
                  "CONTENT_LIMIT",
                  "SOURCE_INVALID",
                  "GENERATION_FAILED",
                  "TRANSCRIPT_UNAVAILABLE",
                  "TRANSCRIPT_TIMEOUT",
                  "TRANSCRIPT_UPSTREAM_UNAVAILABLE",
                  "TRANSCRIPT_REQUEST_FAILED",
                ].includes(error.code)),
        ...(error instanceof NotesGenerationError && error.retryable
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    } finally {
      res.off("close", disconnect);
      res.locals.releaseWorkspaceSlot?.();
      res.end();
    }
  };
  router.post(
    "/process",
    async (req, _res, next) => {
      requireStudyRequest(req);
      next();
    },
    apiRateLimit(requestsPerMinute),
    (req, res, next) => {
      if (active >= 2) {
        res.status(429).json({
          error: {
            code: "WORKSPACE_BUSY",
            message: "The backend is processing two sources. Wait before retrying.",
          },
        });
        return;
      }
      active++;
      let released = false;
      res.locals.releaseWorkspaceSlot = () => {
        if (!released) {
          released = true;
          active--;
        }
      };
      // Keep the slot until parsing/generation finishes, even if a caller disconnects.
      // A running paid job must finish/cache or remain fenced, not be replayed.
      req.once("aborted", res.locals.releaseWorkspaceSlot);
      upload(req, res, (error) => {
        if (error) {
          res.locals.releaseWorkspaceSlot();
          res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
            error: {
              code: "UPLOAD_INVALID",
              message: "Upload one supported file no larger than 20 MB, with source options.",
            },
          });
          return;
        }
        next();
      });
    },
    handler,
  );
  return router;
}
export const workspaceRouter = createWorkspaceRouter();
