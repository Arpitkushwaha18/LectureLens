import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { workspaceCache, type WorkspaceCache } from "../repositories/workspace-cache.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { detailedNotesSchema } from "@lecturelens/contracts";
import { AppError } from "../lib/errors.js";
import { studyLibrary } from "../repositories/study-library.js";
export const recoveryInput = z.strictObject({
  revision: z.string().min(1).max(128),
  action: z.enum([
    "recover_output",
    "confirm_rejected",
    "confirm_not_sent",
    "resolve_abandoned",
    "approve_retry",
  ]),
  reason: z.string().trim().min(20).max(1000),
  acknowledgePossibleCharge: z.boolean().optional(),
});
export function createOperatorRouter(
  cache: () => WorkspaceCache = workspaceCache,
  token: () => string | undefined = () => process.env.OPERATOR_RECOVERY_TOKEN,
) {
  const router = Router();
  router.use((req, res, next) => {
    const expected = token(),
      supplied = req.headers.authorization?.replace(/^Bearer /, "");
    if (
      !expected ||
      expected.length < 32 ||
      !supplied ||
      !timingSafeEqual(
        createHash("sha256").update(expected).digest(),
        createHash("sha256").update(supplied).digest(),
      )
    ) {
      res.status(403).json({
        error: { code: "OPERATOR_FORBIDDEN", message: "Operator authorization required." },
      });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.locals.actor = createHash("sha256").update(expected).digest("hex").slice(0, 16);
    next();
  });
  router.get("/jobs", async (req, res) => {
    if (req.query.store === "supabase") {
      res.json({ data: await hostedJobs() });
      return;
    }
    res.json({ data: cache().inspectJobs() });
  });
  router.post("/resources/:id/remove", async (req, res) => {
    const { reason } = z
      .strictObject({ reason: z.string().trim().min(20).max(1000) })
      .parse(req.body);
    res.json({
      data: {
        removed: await studyLibrary().remove(
          z.uuid().parse(req.params.id),
          String(res.locals.actor),
          reason,
        ),
      },
    });
  });
  router.get("/jobs/:id", async (req, res) => {
    if (req.query.store === "supabase") {
      res.json({ data: (await hostedJobs(String(req.params.id)))[0] });
      return;
    }
    res.json({ data: cache().inspectJob(String(req.params.id)) });
  });
  router.post("/jobs/:id/recover", async (req, res) => {
    const input = recoveryInput.parse(req.body);
    if (req.query.store === "supabase") {
      const job = (await hostedJobs(String(req.params.id)))[0];
      if (!job) throw new AppError("Job not found.", { code: "JOB_NOT_FOUND", statusCode: 404 });
      if (job.revision !== input.revision)
        throw new AppError("Job changed. Inspect again.", {
          code: "RECOVERY_CONFLICT",
          statusCode: 409,
        });
      if (input.action === "recover_output" && job.checkpoint)
        detailedNotesSchema.parse(job.checkpoint);
      const { error } = await getSupabaseAdmin().rpc("operator_recover_generation", {
        p_job_id: req.params.id,
        p_revision: input.revision,
        p_action: input.action,
        p_reason: input.reason,
        p_actor: res.locals.actor,
        p_ack: input.acknowledgePossibleCharge ?? false,
      });
      if (error)
        throw new AppError(
          error.code === "PGRST202"
            ? "Hosted recovery requires the approved local migration 006; no job was changed."
            : "Hosted recovery was rejected. Inspect the current state; no new generation was started.",
          { code: "RECOVERY_UNSAFE", statusCode: 409 },
        );
      res.json({ data: (await hostedJobs(String(req.params.id)))[0] });
      return;
    }
    res.json({ data: cache().recoverJob(String(req.params.id), input, res.locals.actor) });
  });
  return router;
}
async function hostedJobs(id?: string) {
  let query = getSupabaseAdmin()
    .from("generation_jobs")
    .select(
      "*,generated_content(source_id,transcript_id,model_identifier,status,payload,generated_at)",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (id) query = query.eq("id", id);
  const { data, error } = await query;
  if (error)
    throw new AppError("Hosted job inspection failed.", {
      code: "DATABASE_UNAVAILABLE",
      statusCode: 503,
    });
  return (data ?? []).map((job) => ({
    jobId: job.id,
    sourceId: job.generated_content?.source_id,
    model: job.generated_content?.model_identifier,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    revision: job.updated_at,
    deadline: job.leased_until,
    lastProviderStatus: job.provider_status ?? null,
    requestId: job.provider_request_id ?? null,
    lastError: job.last_error_code,
    requestMayHaveBeenSent: job.request_may_have_been_sent ?? "unknown",
    hasOutput: Boolean(job.generated_content?.payload || job.completion_checkpoint),
    checkpoint: job.completion_checkpoint ?? null,
    recoverySafe:
      Boolean(job.generated_content?.payload || job.completion_checkpoint) ||
      job.request_may_have_been_sent === false,
    resolution: job.operator_resolution ?? null,
  }));
}
