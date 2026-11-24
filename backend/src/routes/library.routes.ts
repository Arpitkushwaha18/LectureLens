import { Router } from "express";
import { studyLibrary, type StudyLibrary } from "../repositories/study-library.js";
import { requireStudyRequest } from "../services/study-session.js";
import { libraryControllers } from "../controllers/library.controller.js";
import { apiRateLimit } from "../middleware/rate-limit.js";

export function createLibraryRouter(store: () => StudyLibrary = studyLibrary) {
  const router = Router(),
    controller = libraryControllers(store);
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) requireStudyRequest(req);
    next();
  });
  router.get("/session", controller.session);
  router.post("/session", apiRateLimit(30), controller.session);
  router.post("/auth/:action", apiRateLimit(10), controller.auth);
  router.get("/resources", controller.list);
  router.get("/resources/:id", controller.read);
  router.post("/resources/:id/publish", apiRateLimit(10), controller.publish);
  router.get("/resources/:id/attempts", controller.attempts);
  router.post("/resources/:id/attempts", apiRateLimit(20), controller.submitQuiz);
  // Removal remains operator-only; no user-supplied owner identity is accepted.
  return router;
}
