import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import { notesRouter } from "./notes.routes.js";
import { workspaceRouter } from "./workspace.routes.js";
import { createOperatorRouter } from "./operator.routes.js";
import { createLibraryRouter } from "./library.routes.js";

/**
 * Every feature mounts here under /api/v1.
 * Routes only map URLs to controllers — no business logic lives in this file.
 */
export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/youtube", notesRouter);
apiRouter.use("/workspace", workspaceRouter);
apiRouter.use("/operator", createOperatorRouter());
apiRouter.use("/library", createLibraryRouter());
