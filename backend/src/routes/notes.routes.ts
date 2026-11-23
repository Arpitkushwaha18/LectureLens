import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { detailedNotesController } from "../controllers/notes.controller.js";

export const notesRouter = Router();
notesRouter.post(
  "/detailed-notes",
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute before retrying." },
    },
  }),
  detailedNotesController,
);
