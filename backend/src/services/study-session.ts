import type { Request, Response } from "express";
import { studyLibrary, type StudyLibrary } from "../repositories/study-library.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
export function sessionCookie(req: Request, name = "ll_session") {
  const found = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + "="));
  return found?.slice(name.length + 1);
}
export function writeSession(res: Response, token: string) {
  res.cookie("ll_session", token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    maxAge: 60 * 24 * 60 * 60 * 1000,
    path: "/api/v1",
  });
}
export function requireStudyRequest(req: Request) {
  if (req.headers["x-lecturelens-request"] !== "1")
    throw new AppError("Open UrTutor to start this study request.", {
      code: "STUDY_REQUEST_REQUIRED",
      statusCode: 403,
    });
}
export async function studyActor(
  req: Request,
  res: Response,
  store: StudyLibrary = studyLibrary(),
  required = true,
): Promise<string | null> {
  const token = sessionCookie(req);
  if (!res.headersSent) res.setHeader("Cache-Control", "no-store");
  if (store.storage === "local_postgres") {
    if (!token) {
      if (!required) return null;
      throw new AppError("Open your study session before continuing.", {
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
    }
    const session = await store.guest(token);
    if (session.token !== token) {
      if (required)
        throw new AppError("Your study session expired. Open a new session.", {
          code: "AUTH_REQUIRED",
          statusCode: 401,
        });
      return null;
    }
    return session.ownerId;
  }
  if (token) {
    const { data, error } = await getSupabaseAdmin().auth.getUser(token);
    if (!error && data.user) return data.user.id;
  }
  if (required)
    throw new AppError("Sign in to save private study resources and quiz attempts.", {
      code: "AUTH_REQUIRED",
      statusCode: 401,
    });
  return null;
}
