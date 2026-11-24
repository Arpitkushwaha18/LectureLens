import type { Request, Response } from "express";
import { studyLibrary, type StudyLibrary } from "../repositories/study-library.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { refreshSession } from "./auth.service.js";
import type { Session } from "@supabase/supabase-js";
export function sessionCookie(req: Request, name = "ll_session") {
  const found = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + "="));
  return found?.slice(name.length + 1);
}
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.SESSION_SAME_SITE,
    path: "/api/v1",
  } as const;
}
export function writeSession(res: Response, token: string, seconds = 60 * 24 * 60 * 60) {
  res.cookie("ll_session", token, {
    ...sessionCookieOptions(),
    maxAge: seconds * 1000,
  });
}
export function writeAuthSession(res: Response, session: Session) {
  writeSession(res, session.access_token, session.expires_in);
  res.cookie("ll_refresh", session.refresh_token, {
    ...sessionCookieOptions(),
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}
export function clearSession(res: Response) {
  res.clearCookie("ll_session", sessionCookieOptions());
  res.clearCookie("ll_refresh", sessionCookieOptions());
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
    const session = await store.session(token);
    if (!session) {
      if (required)
        throw new AppError("Your study session expired. Open a new session.", {
          code: "AUTH_REQUIRED",
          statusCode: 401,
        });
      return null;
    }
    return session.ownerId;
  }
  if (token && token.length <= 4096) {
    const { data, error } = await getSupabaseAdmin().auth.getUser(token);
    if (!error && data.user) return data.user.id;
  }
  const refresh = sessionCookie(req, "ll_refresh");
  if (refresh && refresh.length <= 4096 && !res.headersSent) {
    const session = await refreshSession(refresh);
    if (session) {
      writeAuthSession(res, session);
      return session.user.id;
    }
    clearSession(res);
  }
  if (required)
    throw new AppError("Sign in to save private study resources and quiz attempts.", {
      code: "AUTH_REQUIRED",
      statusCode: 401,
    });
  return null;
}
