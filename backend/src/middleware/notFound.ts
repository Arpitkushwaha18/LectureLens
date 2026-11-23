import type { RequestHandler } from "express";

import { notFoundError } from "../lib/errors.js";

/** Anything that matched no route becomes a structured 404. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFoundError(`Route ${req.method} ${req.originalUrl} does not exist`));
};
