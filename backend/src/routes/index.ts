import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import { workspaceRouter } from "./workspace.routes.js";
import { createAdminGalleryRouter } from "./admin-gallery.routes.js";

/**
 * Every feature mounts here under /api/v1.
 * Routes only map URLs to controllers — no business logic lives in this file.
 */
export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/workspace", workspaceRouter);
apiRouter.use("/gallery", createAdminGalleryRouter());
