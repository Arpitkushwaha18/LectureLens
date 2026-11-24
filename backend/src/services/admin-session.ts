import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { sessionCookie } from "./study-session.js";

const cookieName = "ll_gallery_admin";
const cookieOptions = () =>
  ({
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.SESSION_SAME_SITE,
    path: "/api/v1/gallery/admin",
  }) as const;
function secret() {
  if (!env.GALLERY_ADMIN_PASSWORD || env.GALLERY_ADMIN_PASSWORD.length < 16)
    throw new AppError(
      "Admin uploads are not configured. Set a strong GALLERY_ADMIN_PASSWORD on the server.",
      { code: "ADMIN_NOT_CONFIGURED", statusCode: 503 },
    );
  return env.GALLERY_ADMIN_PASSWORD;
}
export function adminLogin(password: string, res: Response) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(password), digest(secret())))
    throw new AppError("Incorrect admin password.", {
      code: "ADMIN_UNAUTHORIZED",
      statusCode: 401,
    });
  const payload = `${Math.floor(Date.now() / 1000) + 3600}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", secret()).update(payload).digest("hex");
  res.cookie(cookieName, `${payload}.${signature}`, { ...cookieOptions(), maxAge: 3600000 });
}
export function isGalleryAdmin(req: Request) {
  const token = sessionCookie(req, cookieName);
  if (!token || token.length > 200 || !env.GALLERY_ADMIN_PASSWORD) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expires, nonce, signature] = parts;
  if (
    !expires ||
    !nonce ||
    !signature ||
    !/^\d{10}$/.test(expires) ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const expected = createHmac("sha256", secret()).update(`${expires}.${nonce}`).digest("hex");
  return (
    Number(expires) > Date.now() / 1000 &&
    timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))
  );
}
export function requireGalleryAdmin(req: Request) {
  if (!isGalleryAdmin(req))
    throw new AppError("Sign in to the admin page first.", {
      code: "ADMIN_UNAUTHORIZED",
      statusCode: 401,
    });
}
export function adminLogout(res: Response) {
  res.clearCookie(cookieName, cookieOptions());
}
