import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { FENCED_JOB_MESSAGE } from "../lib/job-message.js";
import type { GenerationEvidence } from "../modules/ai/generation-evidence.js";
import {
  definitiveFailure,
  retryDelay,
  rejectionCode,
} from "../modules/ai/generation-lifecycle.js";
import {
  notebookSchema,
  extractedSourceSchema,
  type Notebook,
  type ExtractedSource,
} from "@lecturelens/contracts";
import { AppError } from "../lib/errors.js";
import { BACKEND_ROOT } from "../config/load-env.js";

/** Private single-host persistent cache. Never exposed by source hash or job ID. */
export class WorkspaceCache {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "workspace.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`pragma journal_mode=WAL; pragma busy_timeout=5000;
      create table if not exists extraction_cache (identity text primary key, payload text not null);
      create table if not exists material_jobs (identity text primary key, status text not null, token text, deadline integer, payload text, error_code text, retry_at integer, attempts integer not null default 0);
      create table if not exists gallery (id text primary key, video_id text, payload text not null);
      create table if not exists unavailable_captions (identity text primary key, message text not null);`);
    if (
      !this.db
        .prepare("pragma table_info(material_jobs)")
        .all()
        .some((row) => row.name === "operation")
    )
      this.db.exec("alter table material_jobs add column operation text");
    const columns = this.db.prepare("pragma table_info(material_jobs)").all();
    for (const [name, type] of Object.entries({
      model: "text",
      source_id: "text",
      created_at: "integer",
      updated_at: "integer",
      revision: "text",
      checkpoint: "text",
      resolution: "text",
    })) {
      if (!columns.some((row) => row.name === name))
        this.db.exec(`alter table material_jobs add column ${name} ${type}`);
    }
    this.db.exec(
      "create table if not exists job_audit(id integer primary key,job_id text not null,at integer not null,actor text not null,kind text not null,details text not null)",
    );
    this.db
      .exec(`create table if not exists material_attempts(token text primary key,job_id text not null,number integer not null,status text not null,started_at integer not null,finished_at integer,error_code text,request_sent integer,provider_status integer,request_id text);
      create index if not exists material_jobs_operation_status on material_jobs(operation,status);
      create index if not exists material_attempts_job_number on material_attempts(job_id,number);
      create index if not exists job_audit_job_id on job_audit(job_id,id);`);
    this.migrateLegacyJobs();
  }
  private migrateLegacyJobs() {
    this.db.exec("begin immediate");
    try {
      for (const row of this.db
        .prepare(
          "select * from material_jobs where operation is null or source_id like '%:parser-%'",
        )
        .all()) {
        const recovered = this.inspectJob(String(row.identity));
        if (!recovered.operation || row.operation === recovered.operation) continue;
        this.db
          .prepare(
            "update material_jobs set operation=?,model=coalesce(model,?),source_id=coalesce(source_id,?),revision=?,updated_at=? where identity=?",
          )
          .run(
            recovered.operation,
            recovered.model,
            recovered.sourceId,
            randomUUID(),
            Date.now(),
            row.identity!,
          );
        this.audit(
          String(row.identity),
          "migration",
          row.operation ? "legacy_operation_canonicalized" : "legacy_identity_backfilled",
          {
            proof: "Exact preserved cache hash match",
            originalState: {
              status: row.status,
              attempts: row.attempts,
              error: row.error_code,
              token: row.token,
              deadline: row.deadline,
              operation: row.operation,
            },
            operation: recovered.operation,
          },
        );
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  unavailableCaptions(videoId: string, language: string): string | null {
    const row = this.db
      .prepare("select message from unavailable_captions where identity=?")
      .get(`${videoId}:${language}`);
    return row ? String(row.message) : null;
  }
  rememberUnavailableCaptions(videoId: string, language: string, message: string) {
    this.db
      .prepare("insert or ignore into unavailable_captions values (?,?)")
      .run(`${videoId}:${language}`, message);
  }
  extraction(key: string) {
    const row = this.db.prepare("select payload from extraction_cache where identity=?").get(key);
    return row ? extractedSourceSchema.parse(JSON.parse(String(row.payload))) : null;
  }
  saveExtraction(key: string, value: ExtractedSource) {
    this.db
      .prepare(
        "insert into extraction_cache values (?,?) on conflict(identity) do update set payload=excluded.payload",
      )
      .run(key, JSON.stringify(extractedSourceSchema.parse(value)));
  }
  material(key: string): Notebook | null {
    const checkpoint = this.db
      .prepare("select checkpoint,status,deadline,token from material_jobs where identity=?")
      .get(key);
    if (
      checkpoint?.checkpoint &&
      checkpoint.status !== "ready" &&
      (checkpoint.status !== "running" || Number(checkpoint.deadline) <= Date.now())
    ) {
      const notebook = notebookSchema.parse(JSON.parse(String(checkpoint.checkpoint)));
      this.recoverJob(
        key,
        {
          revision: String(this.inspectJob(key).revision),
          action: "recover_output",
          reason: "Automatically reuse validated persisted completion; no new provider request.",
        },
        "automatic",
      );
      return notebook;
    }
    const row = this.db
      .prepare("select payload from material_jobs where identity=? and status='ready'")
      .get(key);
    return row?.payload ? notebookSchema.parse(JSON.parse(String(row.payload))) : null;
  }
  retrySafe(key: string) {
    const row = this.db
      .prepare("select status,error_code from material_jobs where identity=?")
      .get(key);
    return (
      row?.status === "retry_wait" ||
      row?.status === "ready" ||
      (definitiveFailure(String(row?.error_code)) && row?.status !== "running")
    );
  }
  retryAfter(key: string) {
    const row = this.db.prepare("select retry_at from material_jobs where identity=?").get(key);
    return Math.max(1, Math.ceil((Number(row?.retry_at ?? Date.now()) - Date.now()) / 1000));
  }
  checkState(key: string, operation: string, legacyOperation = operation) {
    const rows = this.db
      .prepare(
        "select * from material_jobs where identity=? or operation in (?,?) order by updated_at desc",
      )
      .all(key, operation, legacyOperation);
    for (const row of rows) {
      if (row.status === "running") {
        const evidence = this.inspectJob(String(row.identity));
        if (
          Number(row.deadline) > Date.now() ||
          (evidence.requestMayHaveBeenSent !== false &&
            ![400, 401, 403, 404, 410, 429, 500, 502, 503, 504].includes(
              evidence.lastProviderStatus,
            ))
        )
          return { safe: false, code: "JOB_RECOVERY_REQUIRED", delay: 3 };
      }
      if (
        ["failed", "cancelled"].includes(String(row.status)) &&
        !definitiveFailure(String(row.error_code)) &&
        row.resolution !== "retry_approved"
      )
        return { safe: false, code: "JOB_RECOVERY_REQUIRED", delay: 3 };
    }
    const previous = rows.find((row) => row.identity === key && row.status !== "ready");
    const expired = previous?.status === "running" ? this.inspectJob(key) : null;
    return {
      safe: true,
      code: expired
        ? expired.requestMayHaveBeenSent === false
          ? "GENERATION_CANCELLED_BEFORE_SEND"
          : rejectionCode(expired.lastProviderStatus)
        : String(previous?.error_code ?? "GENERATION_NOT_SENT"),
      delay: Math.max(0, Math.ceil((Number(previous?.retry_at ?? Date.now()) - Date.now()) / 1000)),
    };
  }
  recoveredMaterial(operation: string, legacyOperation = operation): Notebook | null {
    for (const candidate of this.db
      .prepare(
        "select identity from material_jobs where operation in (?,?) and checkpoint is not null and status<>'ready' and (status<>'running' or deadline<=?)",
      )
      .all(operation, legacyOperation, Date.now()))
      this.material(String(candidate.identity));
    const row = this.db
      .prepare(
        "select payload from material_jobs where operation in (?,?) and status='ready' and resolution='recover_output' order by updated_at desc limit 1",
      )
      .get(operation, legacyOperation);
    return row?.payload ? notebookSchema.parse(JSON.parse(String(row.payload))) : null;
  }
  claim(
    key: string,
    operation?: string,
    metadata?: { model: string; sourceId: string; legacyOperation?: string; leaseMs?: number },
  ): string | null {
    this.db.exec("begin immediate");
    try {
      const row = this.db.prepare("select * from material_jobs where identity=?").get(key);
      if (row?.status === "running" && Number(row.deadline) <= Date.now()) {
        const evidence = this.inspectJob(key);
        if (
          evidence.requestMayHaveBeenSent === false ||
          [400, 401, 403, 404, 410, 429, 500, 502, 503, 504].includes(evidence.lastProviderStatus)
        ) {
          const code =
            evidence.requestMayHaveBeenSent === false
              ? "GENERATION_CANCELLED_BEFORE_SEND"
              : rejectionCode(evidence.lastProviderStatus);
          this.audit(key, "automatic", "expired_attempt_reconciled", {
            originalToken: row.token,
            providerStatus: evidence.lastProviderStatus,
            code,
          });
          this.db
            .prepare(
              "update material_jobs set status='failed',token=null,deadline=null,error_code=?,retry_at=?,revision=?,updated_at=? where identity=? and token=?",
            )
            .run(
              code,
              Math.max(Date.now(), Number(row.retry_at ?? 0)),
              randomUUID(),
              Date.now(),
              key,
              row.token!,
            );
          this.db
            .prepare(
              "update material_attempts set status='failed',error_code=?,finished_at=? where token=?",
            )
            .run(code, Date.now(), row.token!);
          row.status = "failed";
          row.error_code = code;
          row.retry_at = Math.max(Date.now(), Number(row.retry_at ?? 0));
        }
      }
      if (row?.status === "ready") {
        this.db.exec("commit");
        return null;
      }
      if (operation) {
        for (const candidate of this.db
          .prepare(
            "select identity,token,retry_at from material_jobs where identity<>? and operation in (?,?) and status='running' and deadline<=?",
          )
          .all(key, operation, metadata?.legacyOperation ?? operation, Date.now())) {
          const other = this.inspectJob(String(candidate.identity));
          if (
            other.requestMayHaveBeenSent === false ||
            [400, 401, 403, 404, 410, 429, 500, 502, 503, 504].includes(other.lastProviderStatus)
          ) {
            const code =
              other.requestMayHaveBeenSent === false
                ? "GENERATION_CANCELLED_BEFORE_SEND"
                : rejectionCode(other.lastProviderStatus);
            this.audit(String(candidate.identity), "automatic", "expired_attempt_reconciled", {
              originalToken: candidate.token,
              providerStatus: other.lastProviderStatus,
              code,
            });
            this.db
              .prepare(
                "update material_jobs set status='failed',token=null,deadline=null,error_code=?,retry_at=?,revision=?,updated_at=? where identity=? and token=?",
              )
              .run(
                code,
                Math.max(Date.now(), Number(candidate.retry_at ?? 0)),
                randomUUID(),
                Date.now(),
                candidate.identity!,
                candidate.token!,
              );
            this.db
              .prepare(
                "update material_attempts set status='failed',finished_at=?,error_code=? where token=?",
              )
              .run(Date.now(), code, candidate.token!);
          }
        }
        const uncertain = this.db
          .prepare(
            "select identity,status,error_code,resolution from material_jobs where identity<>? and operation in (?,?) and status in ('running','failed','cancelled')",
          )
          .all(key, operation, metadata?.legacyOperation ?? operation)
          .find(
            (other) =>
              other.status === "running" ||
              (!definitiveFailure(String(other.error_code)) &&
                other.resolution !== "retry_approved"),
          );
        if (uncertain)
          throw new AppError(FENCED_JOB_MESSAGE, {
            code: "JOB_RECOVERY_REQUIRED",
            statusCode: 503,
          });
      }
      if (
        (row?.status === "failed" &&
          !definitiveFailure(String(row.error_code)) &&
          row.resolution !== "retry_approved") ||
        (row?.status === "cancelled" && !definitiveFailure(String(row.error_code))) ||
        (row?.status === "running" && Number(row.deadline) <= Date.now())
      )
        throw new AppError(FENCED_JOB_MESSAGE, { code: "JOB_RECOVERY_REQUIRED", statusCode: 503 });
      if (
        row?.status === "running" ||
        (["retry_wait", "failed", "cancelled"].includes(String(row?.status)) &&
          Number(row?.retry_at) > Date.now())
      ) {
        this.db.exec("commit");
        return null;
      }
      const count = this.db
        .prepare("select count(*) as n from material_jobs where status='running' and deadline>?")
        .get(Date.now());
      if (Number(count?.n) >= 2) {
        this.db.exec("commit");
        return null;
      }
      const token = randomUUID();
      if (row && ["failed", "cancelled"].includes(String(row.status)))
        this.audit(key, "automatic", "definitive_attempt_superseded", {
          error: row.error_code,
          attempt: row.attempts,
          resolution: row.resolution,
        });
      this.db
        .prepare(
          "insert into material_jobs(identity,status,token,deadline,attempts,operation) values (?,'running',?,?,1,?) on conflict(identity) do update set status='running',token=excluded.token,deadline=excluded.deadline,attempts=material_jobs.attempts+1,operation=excluded.operation",
        )
        .run(
          key,
          token,
          Date.now() + Math.min(360000, Math.max(180000, metadata?.leaseMs ?? 180000)),
          operation ?? null,
        );
      this.db
        .prepare(
          "update material_jobs set model=coalesce(?,model),source_id=coalesce(?,source_id),created_at=coalesce(created_at,?),updated_at=?,revision=?,resolution=null,checkpoint=null,error_code=null where identity=?",
        )
        .run(
          metadata?.model ?? null,
          metadata?.sourceId ?? null,
          Date.now(),
          Date.now(),
          randomUUID(),
          key,
        );
      this.audit(key, "worker", "claimed", {
        attempt: Number(row?.attempts ?? 0) + 1,
        requestMayHaveBeenSent: false,
      });
      this.db
        .prepare(
          "insert into material_attempts(token,job_id,number,status,started_at,request_sent) values (?,?,?,'running',?,0)",
        )
        .run(token, key, Number(row?.attempts ?? 0) + 1, Date.now());
      this.db.exec("commit");
      return token;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  finish(key: string, token: string, notebook: Notebook) {
    this.db.exec("begin immediate");
    try {
      const result = this.db
        .prepare(
          "update material_jobs set status='ready',payload=?,token=null,deadline=null,updated_at=?,revision=? where identity=? and token=? and status='running' and deadline>?",
        )
        .run(
          JSON.stringify(notebookSchema.parse(notebook)),
          Date.now(),
          randomUUID(),
          key,
          token,
          Date.now(),
        );
      if (!result.changes)
        throw new AppError("Generation lease was lost. No duplicate request will be started.", {
          code: "JOB_LEASE_LOST",
          statusCode: 503,
        });
      this.db
        .prepare(
          "update material_attempts set status='completed',finished_at=? where token=? and status='running'",
        )
        .run(Date.now(), token);
      this.audit(key, "worker", "completed", { token });
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  fail(key: string, token: string, code: string, retryable: boolean, retryAfterSeconds = 60) {
    retryable = retryable && definitiveFailure(code);
    const attempts = Number(
      this.db.prepare("select attempts from material_jobs where identity=?").get(key)?.attempts ||
        1,
    );
    const delay = retryable ? retryDelay(attempts, retryAfterSeconds) : 0;
    this.db.exec("begin immediate");
    try {
      const result = this.db
        .prepare(
          "update material_jobs set status=case when ? and attempts<3 then 'retry_wait' else 'failed' end,error_code=?,retry_at=?,token=null,deadline=null,updated_at=?,revision=? where identity=? and token=? and status='running'",
        )
        .run(
          retryable ? 1 : 0,
          code,
          Date.now() + delay * 1000,
          Date.now(),
          randomUUID(),
          key,
          token,
        );
      if (result.changes) this.audit(key, "worker", "failure", { classification: code, retryable });
      if (result.changes)
        this.db
          .prepare(
            "update material_attempts set status=?,finished_at=?,error_code=? where token=? and status='running'",
          )
          .run(definitiveFailure(code) ? "failed" : "uncertain", Date.now(), code, token);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  private audit(key: string, actor: string, kind: string, details: unknown) {
    this.db
      .prepare("insert into job_audit(job_id,at,actor,kind,details) values (?,?,?,?,?)")
      .run(key, Date.now(), actor, kind, JSON.stringify(details));
  }
  cancelBeforeSend(key: string, token: string) {
    this.db.exec("begin immediate");
    try {
      const current = this.inspectJob(key);
      if (current.status !== "running" || current.requestMayHaveBeenSent !== false)
        throw new AppError(FENCED_JOB_MESSAGE, { code: "JOB_RECOVERY_REQUIRED", statusCode: 409 });
      const changed = this.db
        .prepare(
          "update material_jobs set status='cancelled',token=null,deadline=null,error_code='GENERATION_CANCELLED_BEFORE_SEND',retry_at=?,updated_at=?,revision=? where identity=? and token=? and status='running'",
        )
        .run(Date.now(), Date.now(), randomUUID(), key, token);
      if (!changed.changes)
        throw new AppError(FENCED_JOB_MESSAGE, { code: "JOB_LEASE_LOST", statusCode: 409 });
      this.db
        .prepare(
          "update material_attempts set status='cancelled',finished_at=?,error_code='GENERATION_CANCELLED_BEFORE_SEND' where token=?",
        )
        .run(Date.now(), token);
      this.audit(key, "worker", "cancelled_before_send", { token });
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  evidence(key: string, token: string, event: GenerationEvidence) {
    this.db.exec("begin immediate");
    try {
      const result = this.db
        .prepare(
          "update material_jobs set updated_at=?,revision=? where identity=? and token=? and status='running' and (?<>'dispatch' or deadline>?)",
        )
        .run(Date.now(), randomUUID(), key, token, event.kind, Date.now());
      if (!result.changes)
        throw new AppError("Generation evidence lease was lost.", {
          code: "JOB_LEASE_LOST",
          statusCode: 409,
        });
      this.audit(key, "worker", event.kind, event);
      if (event.kind === "response" && [429, 500, 502, 503, 504].includes(event.httpStatus ?? 0)) {
        const attempt = this.db
          .prepare("select attempts from material_jobs where identity=?")
          .get(key);
        this.db
          .prepare(
            "update material_jobs set retry_at=max(coalesce(retry_at,0),?) where identity=? and token=?",
          )
          .run(
            Date.now() +
              retryDelay(Number(attempt?.attempts ?? 1), event.retryAfterSeconds ?? 60) * 1000,
            key,
            token,
          );
      }
      this.db
        .prepare(
          "update material_attempts set request_sent=case when ?='dispatch' then 1 when ?='not_sent' then 0 else request_sent end,provider_status=coalesce(?,provider_status),request_id=coalesce(?,request_id) where token=? and status='running'",
        )
        .run(event.kind, event.kind, event.httpStatus ?? null, event.requestId ?? null, token);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  checkpoint(key: string, token: string, notebook: Notebook) {
    this.db.exec("begin immediate");
    try {
      const result = this.db
        .prepare(
          "update material_jobs set checkpoint=?,updated_at=?,revision=? where identity=? and token=? and status='running'",
        )
        .run(JSON.stringify(notebookSchema.parse(notebook)), Date.now(), randomUUID(), key, token);
      if (!result.changes)
        throw new AppError("Generation checkpoint lease was lost.", {
          code: "JOB_LEASE_LOST",
          statusCode: 409,
        });
      this.audit(key, "worker", "validated", {});
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  inspectJobs() {
    return this.db
      .prepare("select identity from material_jobs order by rowid desc limit 100")
      .all()
      .map((row) => this.inspectJob(String(row.identity)));
  }
  inspectJob(key: string) {
    const row = this.db.prepare("select * from material_jobs where identity=?").get(key);
    if (!row) throw new AppError("Job not found.", { code: "JOB_NOT_FOUND", statusCode: 404 });
    const audit = this.db
      .prepare("select at,actor,kind,details from job_audit where job_id=? order by id")
      .all(key)
      .map((entry) => ({
        at: Number(entry.at),
        actor: String(entry.actor),
        kind: String(entry.kind),
        details: JSON.parse(String(entry.details)),
      }));
    // Legacy metadata is recovered by exact cache hash comparison, never inferred from the error.
    let model = row.model ? String(row.model) : null,
      sourceId = row.source_id ? String(row.source_id) : null,
      operation = row.operation ? String(row.operation) : null;
    if (!operation || sourceId?.includes(":parser-")) {
      for (const entry of this.db.prepare("select identity,payload from extraction_cache").all()) {
        const source = JSON.parse(String(entry.payload));
        for (const candidate of new Set(
          ["gemini-3.8-flash", "gemini-2.5-flash", model, process.env.GEMINI_MODEL].filter(
            (value): value is string => Boolean(value),
          ),
        ))
          for (const outputType of [
            "detailed_notes",
            "short_notes",
            "flashcards",
            "mcq_quiz",
            "mindmap",
            "sample_question_paper",
          ]) {
            if (
              createHash("sha256")
                .update(
                  JSON.stringify({
                    source: source.kind,
                    text: source.text,
                    outputType,
                    model: candidate,
                    prompt: "study-notebook-v2-1",
                    schema: 2,
                  }),
                )
                .digest("hex") === key
            ) {
              model = candidate;
              sourceId = String(entry.identity);
              const fileHash = sourceId.split(":").at(-1);
              operation = createHash("sha256")
                .update(
                  fileHash?.match(/^[a-f0-9]{64}$/)
                    ? JSON.stringify({
                        source: source.kind,
                        contentHash: fileHash,
                        outputType,
                        language: "en",
                      })
                    : JSON.stringify({ source: source.kind, text: source.text, outputType }),
                )
                .digest("hex");
            }
          }
      }
    }
    const claimed = audit.map((e) => e.kind).lastIndexOf("claimed"),
      attempt = audit.slice(Math.max(0, claimed));
    const response = attempt.filter((e) => e.kind === "response").at(-1)?.details;
    return {
      jobId: key,
      sourceId,
      operation,
      model,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      revision: row.revision ?? String(row.token ?? "legacy"),
      deadline: row.deadline ?? null,
      lastProviderStatus: response?.httpStatus ?? null,
      requestId: response?.requestId ?? null,
      lastError: row.error_code ?? null,
      requestMayHaveBeenSent:
        claimed < 0
          ? "unknown"
          : attempt.filter((e) => ["dispatch", "not_sent"].includes(e.kind)).at(-1)?.kind ===
            "dispatch",
      hasOutput: Boolean(row.payload || row.checkpoint),
      resolution: row.resolution ?? null,
      recoverySafe:
        Boolean(row.payload || row.checkpoint) ||
        (definitiveFailure(String(row.error_code)) && row.status !== "running") ||
        [400, 401, 403, 404, 410, 429, 500, 502, 503, 504].includes(response?.httpStatus) ||
        (claimed >= 0 && !attempt.some((e) => e.kind === "dispatch")),
      audit,
    };
  }
  recoverJob(
    key: string,
    input: {
      revision: string;
      action:
        | "recover_output"
        | "confirm_rejected"
        | "confirm_not_sent"
        | "resolve_abandoned"
        | "approve_retry";
      reason: string;
      acknowledgePossibleCharge?: boolean;
    },
    actor: string,
  ) {
    this.db.exec("begin immediate");
    try {
      const current = this.inspectJob(key),
        row = this.db.prepare("select * from material_jobs where identity=?").get(key)!;
      if (current.revision !== input.revision)
        throw new AppError("Job changed. Inspect it again before recovery.", {
          code: "RECOVERY_CONFLICT",
          statusCode: 409,
        });
      if (row.status === "ready") {
        this.db.exec("commit");
        return current;
      }
      const active = row.status === "running" && Number(row.deadline) > Date.now();
      if ((row.payload || row.checkpoint) && input.action !== "recover_output")
        throw new AppError(
          "A completed output exists. Recover it instead of permitting another charge.",
          { code: "RECOVERY_UNSAFE", statusCode: 409 },
        );
      let status = "failed",
        resolution = input.action,
        payload: string | null = null;
      if (input.action === "recover_output") {
        if (!row.payload && !row.checkpoint)
          throw new AppError(
            "No validated completion checkpoint exists. Gemini synchronous requests cannot be retrieved by job hash.",
            { code: "RECOVERY_UNSAFE", statusCode: 409 },
          );
        payload = JSON.stringify(
          notebookSchema.parse(JSON.parse(String(row.payload || row.checkpoint))),
        );
        status = "ready";
      } else if (active)
        throw new AppError("The worker lease is active. Recovery cannot release it.", {
          code: "RECOVERY_UNSAFE",
          statusCode: 409,
        });
      else if (
        input.action === "confirm_rejected" &&
        ![400, 401, 403, 404, 410, 429, 500, 502, 503, 504].includes(current.lastProviderStatus)
      )
        throw new AppError("No definitive rejection is recorded for the current attempt.", {
          code: "RECOVERY_UNSAFE",
          statusCode: 409,
        });
      else if (input.action === "confirm_not_sent" && current.requestMayHaveBeenSent !== false)
        throw new AppError("Request dispatch cannot be ruled out.", {
          code: "RECOVERY_UNSAFE",
          statusCode: 409,
        });
      else if (input.action === "resolve_abandoned" && !input.acknowledgePossibleCharge)
        throw new AppError(
          "Explicit operator acknowledgment of an uncheckable request and possible charge is required.",
          { code: "RECOVERY_UNSAFE", statusCode: 409 },
        );
      else if (input.action === "approve_retry") {
        if (
          !["confirm_rejected", "confirm_not_sent", "resolve_abandoned"].includes(
            String(row.resolution),
          )
        )
          throw new AppError(
            "Resolve the earlier outcome first; retry cannot bypass an uncertain job.",
            { code: "RECOVERY_UNSAFE", statusCode: 409 },
          );
        status = "retry_wait";
        resolution = "retry_approved" as typeof resolution;
      }
      const { audit: history, ...before } = current;
      void history;
      this.audit(key, actor, input.action, {
        reason: input.reason,
        acknowledgePossibleCharge: input.acknowledgePossibleCharge ?? false,
        before,
        originalToken: row.token,
      });
      const resolvedError =
        input.action === "resolve_abandoned"
          ? "OPERATOR_ABANDONED"
          : input.action === "confirm_not_sent"
            ? "GENERATION_NOT_SENT"
            : input.action === "confirm_rejected"
              ? rejectionCode(current.lastProviderStatus)
              : null;
      this.db
        .prepare(
          "update material_jobs set status=?,payload=coalesce(?,payload),token=null,deadline=null,resolution=?,error_code=coalesce(?,error_code),retry_at=?,updated_at=?,revision=?,operation=coalesce(operation,?),model=coalesce(model,?),source_id=coalesce(source_id,?) where identity=?",
        )
        .run(
          status,
          payload,
          resolution,
          resolvedError ?? null,
          Date.now(),
          Date.now(),
          randomUUID(),
          current.operation,
          current.model,
          current.sourceId,
          key,
        );
      if (row.token)
        this.db
          .prepare(
            "update material_attempts set status=?,finished_at=?,error_code=coalesce(?,error_code) where token=? and status='running'",
          )
          .run(status === "ready" ? "completed" : "resolved", Date.now(), resolvedError, row.token);
      this.db.exec("commit");
      return this.inspectJob(key);
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
  gallery(videoId?: string) {
    const rows = videoId
      ? this.db.prepare("select id,payload from gallery where video_id=? limit 50").all(videoId)
      : this.db.prepare("select id,payload from gallery order by rowid desc limit 50").all();
    return rows.map((row) => ({
      id: String(row.id),
      notebook: notebookSchema.parse(JSON.parse(String(row.payload))),
    }));
  }
  publishGallery(notebook: Notebook, videoId?: string) {
    if (videoId && !/^[A-Za-z0-9_-]{11}$/.test(videoId))
      throw new Error("Invalid YouTube video ID");
    const id = randomUUID();
    this.db
      .prepare("insert into gallery values (?,?,?)")
      .run(id, videoId ?? null, JSON.stringify(notebookSchema.parse(notebook)));
    return id;
  }
}
let singleton: WorkspaceCache | undefined;
export function workspaceCache() {
  return (singleton ??= new WorkspaceCache(
    process.env.WORKSPACE_DATA_DIR || join(BACKEND_ROOT, ".cache", "workspace"),
  ));
}
