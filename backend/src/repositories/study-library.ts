import { PGlite } from "@electric-sql/pglite";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  resourceSchema,
  resourceSummarySchema,
  resourceListSchema,
  resourceContentSchema,
  publishPermissionSchema,
  quizAttemptSchema,
  type StudyResource,
  type ResourceContent,
  type PublishPermission,
} from "@lecturelens/contracts";
import { env } from "../config/env.js";
import { BACKEND_ROOT } from "../config/load-env.js";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { AppError } from "../lib/errors.js";
export const libraryMigration = "20261122000800_shared_study_library.sql";
const localMigrations = [
  libraryMigration,
  "20261122001000_library_removal_and_related.sql",
  "20261123001500_library_integrity.sql",
  "20261123001600_durable_private_generation.sql",
];
const signatures: Record<string, string[]> = {
  study_generation: ["text", "text", "text", "uuid", "jsonb"],
  study_read: ["uuid", "uuid"],
  study_find: ["text", "uuid"],
  study_save: ["uuid", "text", "text", "jsonb", "jsonb", "jsonb"],
  study_list: ["uuid", "jsonb"],
  study_publish: ["uuid", "uuid", "jsonb"],
  study_remove: ["uuid", "text", "text"],
  study_submit_quiz: ["uuid", "uuid", "uuid", "jsonb"],
  study_attempts: ["uuid", "uuid"],
  study_related: ["text", "text", "jsonb"],
};
export function libraryUnavailable(): never {
  throw new AppError(
    "Your library could not be saved or loaded. Check the local database or approve the prepared Supabase library migration. No new generation should be started until storage is ready.",
    { code: "LIBRARY_UNAVAILABLE", statusCode: 503 },
  );
}
export class StudyLibrary {
  private database?: Promise<PGlite>;
  constructor(
    public readonly storage: "local_postgres" | "supabase",
    private directory = resolve(BACKEND_ROOT, ".cache/library"),
  ) {}
  private db() {
    return (this.database ??= this.open());
  }
  private async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const db = new PGlite(this.directory);
    await db.waitReady;
    await db.exec(`create table if not exists library_migrations(name text primary key);`);
    for (const name of localMigrations) {
      const exists = await db.query("select name from library_migrations where name=$1", [name]);
      if (!exists.rows.length) {
        const sql = await readFile(resolve(BACKEND_ROOT, "../supabase/migrations", name), "utf8");
        await db.transaction(async (tx) => {
          if (name === libraryMigration)
            await tx.exec(
              `create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to service_role;`,
            );
          await tx.exec(sql);
          await tx.exec("grant usage on schema ll_private to service_role");
          await tx.query("insert into library_migrations values($1)", [name]);
        });
      }
    }
    return db;
  }
  async ready() {
    try {
      if (this.storage === "local_postgres") await this.db();
      else {
        const { error } = await getSupabaseAdmin().rpc("study_list", {
          p_owner: null,
          p_filters: {},
        });
        if (error) libraryUnavailable();
        const probe = await getSupabaseAdmin().rpc("study_related", {
          p_source: "",
          p_subject: null,
          p_outputs: [],
        });
        if (probe.error) libraryUnavailable();
        const generation = await getSupabaseAdmin().rpc("study_generation", {
          p_key: "0".repeat(64),
          p_operation: "0".repeat(64),
          p_action: "read",
          p_token: null,
          p_value: {},
        });
        if (generation.error) libraryUnavailable();
      }
    } catch {
      libraryUnavailable();
    }
  }
  async close() {
    if (this.database) await (await this.database).close();
  }
  async rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    try {
      if (!signatures[name]) throw new Error("Unknown library operation");
      if (this.storage === "supabase") {
        const { data, error } = await getSupabaseAdmin().rpc(name, parameters);
        if (error) libraryUnavailable();
        return data;
      }
      const types = signatures[name]!,
        values = Object.values(parameters).map((v, i) =>
          types[i] === "jsonb" ? JSON.stringify(v) : v,
        );
      return (
        await (
          await this.db()
        ).transaction(async (tx) => {
          await tx.exec("set local role service_role");
          return await tx.query<{ value: unknown }>(
            `select public.${name}(${types.map((type, i) => `$${i + 1}::${type}`).join(",")}) as value`,
            values,
          );
        })
      ).rows[0]?.value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      libraryUnavailable();
    }
  }
  async read(id: string, ownerId: string | null): Promise<StudyResource | null> {
    const value = await this.rpc("study_read", { p_id: id, p_owner: ownerId });
    return value ? resourceSchema.parse(value) : null;
  }
  async find(key: string, ownerId: string) {
    const id = await this.rpc("study_find", { p_shared: key, p_owner: ownerId });
    return id ? this.read(String(id), ownerId) : null;
  }
  async list(ownerId: string | null, filters: Record<string, unknown>) {
    return resourceListSchema.parse({
      ...((await this.rpc("study_list", { p_owner: ownerId, p_filters: filters })) as object),
      storage: this.storage,
    });
  }
  async related(source: string, subject: string | null, outputs: string[]) {
    return z.array(resourceSummarySchema).parse(
      await this.rpc("study_related", {
        p_source: source,
        p_subject: subject,
        p_outputs: outputs,
      }),
    );
  }
  async save(
    ownerId: string,
    key: string,
    metadata: Record<string, unknown>,
    content: ResourceContent,
    provenance: Record<string, unknown>,
  ) {
    const body = resourceContentSchema.parse(content);
    const id = await this.rpc("study_save", {
      p_owner: ownerId,
      p_request: key,
      p_shared: key,
      p_meta: metadata,
      p_content: body,
      p_provenance: provenance,
    });
    const result = await this.read(z.uuid().parse(id), ownerId);
    if (!result) libraryUnavailable();
    return result;
  }
  async publish(id: string, ownerId: string, permission: PublishPermission) {
    const own = await this.read(id, ownerId);
    if (!own?.owned)
      throw new AppError("Only the resource owner can publish it.", {
        code: "RESOURCE_FORBIDDEN",
        statusCode: 403,
      });
    const saved = await this.rpc("study_publish", {
      p_id: id,
      p_owner: ownerId,
      p_permission: publishPermissionSchema.parse(permission),
    });
    return this.read(z.uuid().parse(saved), ownerId);
  }
  async submitQuiz(id: string, ownerId: string, submissionId: string, answers: (number | null)[]) {
    const resource = await this.read(id, ownerId);
    if (resource?.content.type !== "mcq_quiz")
      throw new AppError("Quiz not found.", { code: "RESOURCE_NOT_FOUND", statusCode: 404 });
    const questions = resource.content.questions;
    if (
      answers.length !== questions.length ||
      answers.some(
        (a, i) =>
          a !== null && (!Number.isInteger(a) || a < 0 || a >= questions[i]!.options.length),
      )
    )
      throw new AppError("Choose valid answers.", { code: "QUIZ_INVALID", statusCode: 400 });
    const attemptId = await this.rpc("study_submit_quiz", {
      p_id: id,
      p_owner: ownerId,
      p_submission: submissionId,
      p_answers: answers,
    });
    const attempts = await this.attempts(id, ownerId);
    const attempt = attempts.find((a) => a.id === attemptId);
    if (!attempt) libraryUnavailable();
    return attempt;
  }
  async attempts(id: string, ownerId: string) {
    return z
      .array(quizAttemptSchema)
      .parse(await this.rpc("study_attempts", { p_id: id, p_owner: ownerId }));
  }
  async remove(id: string, actor: string, reason: string) {
    return this.rpc("study_remove", { p_id: id, p_actor: actor, p_reason: reason });
  }
  async guest(token?: string) {
    if (this.storage !== "local_postgres")
      throw new AppError("Sign in to keep your private study resources.", {
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
    const db = await this.db();
    const existing = await this.session(token);
    if (existing) return existing;
    const fresh = randomBytes(32).toString("base64url"),
      ownerId = randomUUID();
    await db.query(
      "insert into ll_private.study_guest_sessions(token_hash,owner_id) values($1,$2)",
      [createHash("sha256").update(fresh).digest("hex"), ownerId],
    );
    return { ownerId, token: fresh };
  }
  async session(token?: string) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await (
      await this.db()
    ).query<{ owner_id: string }>(
      "select owner_id from ll_private.study_guest_sessions where token_hash=$1 and created_at > now() - interval '60 days'",
      [createHash("sha256").update(token).digest("hex")],
    );
    return result.rows[0] ? { ownerId: result.rows[0].owner_id, token } : null;
  }
}
let singleton: StudyLibrary | undefined;
export function studyLibrary() {
  return (singleton ??= new StudyLibrary(env.LIBRARY_STORE));
}
