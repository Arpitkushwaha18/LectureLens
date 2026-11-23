import type { RequestHandler } from "express";
import { generateDetailedNotes } from "../services/notes.service.js";

export function createDetailedNotesController(generate = generateDetailedNotes): RequestHandler {
  return async (req, res) => {
    const outcome = await generate(req.body);
    res.setHeader("Cache-Control", "no-store");
    const pending = outcome.status === "processing" || outcome.status === "extracting";
    if (pending) res.setHeader("Retry-After", outcome.retryAfterSeconds);
    res.status(pending ? 202 : 200).json({ data: outcome });
  };
}
export const detailedNotesController = createDetailedNotesController();
