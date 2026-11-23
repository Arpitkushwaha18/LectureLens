import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { studyLibrary, type StudyLibrary } from "../repositories/study-library.js";
import {
  studyActor,
  requireStudyRequest,
  sessionCookie,
  writeSession,
} from "../services/study-session.js";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
export function createLibraryRouter(store: () => StudyLibrary = studyLibrary) {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) requireStudyRequest(req);
    next();
  });
  router.get("/session", async (req, res) => {
    res.json({
      data: {
        ownerId: await studyActor(req, res, store(), false),
        storage: store().storage,
        mode: store().storage === "supabase" ? "account" : "guest",
      },
    });
  });
  router.post("/session", async (req, res) => {
    if (store().storage === "supabase") {
      res.json({
        data: {
          ownerId: await studyActor(req, res, store(), false),
          storage: "supabase",
          mode: "account",
        },
      });
      return;
    }
    const session = await store().guest(sessionCookie(req));
    writeSession(res, session.token);
    res.json({ data: { ownerId: session.ownerId, storage: "local_postgres", mode: "guest" } });
  });
  router.post(
    "/auth/:action",
    rateLimit({ windowMs: 60000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }),
    async (req, res) => {
      if (store().storage !== "supabase")
        throw new AppError(
          "Local development uses a private device session. Account sign-in is available with approved Supabase setup.",
          { code: "AUTH_NOT_CONFIGURED", statusCode: 503 },
        );
      if (req.params.action === "logout") {
        res.clearCookie("ll_session", { path: "/api/v1" });
        res.json({ data: { ok: true } });
        return;
      }
      const { email, password } = z
        .strictObject({ email: z.email().max(254), password: z.string().min(8).max(128) })
        .parse(req.body);
      const auth = createClient(env.SUPABASE_URL!, env.SUPABASE_SECRET_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      }).auth;
      const result =
        req.params.action === "signup"
          ? await auth.signUp({ email, password })
          : req.params.action === "login"
            ? await auth.signInWithPassword({ email, password })
            : null;
      if (!result || result.error)
        throw new AppError(
          "Sign-in could not be completed. Check your credentials or account confirmation.",
          { code: "AUTH_FAILED", statusCode: 401 },
        );
      if (result.data.session) writeSession(res, result.data.session.access_token);
      res.json({
        data: {
          confirmed: Boolean(result.data.session),
          message: result.data.session
            ? "Welcome to your study corner."
            : "Check your email to confirm your account before signing in.",
        },
      });
    },
  );
  return router;
}
