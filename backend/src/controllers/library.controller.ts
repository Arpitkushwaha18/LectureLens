import type { RequestHandler } from "express";
import { z } from "zod";
import {
  resourceListFiltersSchema,
  publishPermissionSchema,
  quizSubmissionSchema,
} from "@lecturelens/contracts";
import type { StudyLibrary } from "../repositories/study-library.js";
import {
  studyActor,
  sessionCookie,
  writeSession,
  writeAuthSession,
  clearSession,
} from "../services/study-session.js";
import { authenticate, authClient } from "../services/auth.service.js";
import { AppError } from "../lib/errors.js";

export function libraryControllers(store: () => StudyLibrary) {
  const resourceId = (value: unknown) => z.uuid().parse(value);
  const session: RequestHandler = async (req, res) => {
    const library = store();
    let ownerId = await studyActor(req, res, library, false);
    if (req.method === "POST" && library.storage === "local_postgres" && !ownerId) {
      const guest = await library.guest(sessionCookie(req));
      writeSession(res, guest.token);
      ownerId = guest.ownerId;
    }
    res.json({
      data: {
        ownerId,
        storage: library.storage,
        mode: library.storage === "supabase" ? "account" : "guest",
      },
    });
  };
  const auth: RequestHandler = async (req, res) => {
    if (store().storage !== "supabase")
      throw new AppError(
        "Local development uses a private device session. Account sign-in requires Supabase.",
        { code: "AUTH_NOT_CONFIGURED", statusCode: 503 },
      );
    const action = z.enum(["login", "signup", "logout"]).parse(req.params.action);
    if (action === "logout") {
      const token = sessionCookie(req);
      try {
        if (token && token.length <= 4096) await authClient().admin.signOut(token, "local");
      } finally {
        clearSession(res);
      }
      res.json({ data: { ok: true, message: "Signed out." } });
      return;
    }
    const signedIn = await authenticate(action, req.body);
    if (signedIn) writeAuthSession(res, signedIn);
    res.json({
      data: {
        confirmed: Boolean(signedIn),
        message: signedIn
          ? "Welcome to your study corner."
          : "Check your email to confirm your account before signing in.",
      },
    });
  };
  const list: RequestHandler = async (req, res) => {
    const library = store(),
      filters = resourceListFiltersSchema.parse(req.query);
    const owner = await studyActor(req, res, library, filters.scope === "mine");
    res.json({ data: await library.list(owner, filters) });
  };
  const read: RequestHandler = async (req, res) => {
    const library = store(),
      owner = await studyActor(req, res, library, false);
    const resource = await library.read(resourceId(req.params.id), owner);
    if (!resource)
      throw new AppError("Resource not found.", { code: "RESOURCE_NOT_FOUND", statusCode: 404 });
    res.json({ data: resource });
  };
  const publish: RequestHandler = async (req, res) => {
    const library = store(),
      owner = (await studyActor(req, res, library))!;
    res.json({
      data: await library.publish(
        resourceId(req.params.id),
        owner,
        publishPermissionSchema.parse(req.body),
      ),
    });
  };
  const attempts: RequestHandler = async (req, res) => {
    const library = store(),
      owner = (await studyActor(req, res, library))!;
    res.json({ data: await library.attempts(resourceId(req.params.id), owner) });
  };
  const submitQuiz: RequestHandler = async (req, res) => {
    const library = store(),
      owner = (await studyActor(req, res, library))!,
      body = quizSubmissionSchema.parse(req.body);
    res.json({
      data: await library.submitQuiz(
        resourceId(req.params.id),
        owner,
        body.submissionId,
        body.answers,
      ),
    });
  };
  return { session, auth, list, read, publish, attempts, submitQuiz };
}
