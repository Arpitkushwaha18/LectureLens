import { z } from "zod";
import { notebookSchema, type Notebook } from "@lecturelens/contracts";
import type { WorkspaceCache } from "./workspace-cache.js";
import type { GenerationEvidence } from "../modules/ai/generation-evidence.js";
import { learningRpc } from "./youtube-notebooks.js";
import { AppError } from "../lib/errors.js";

type Awaitable<T> = T | Promise<T>;
export interface GenerationStore {
  material(key: string): Awaitable<Notebook | null>;
  checkState(
    key: string,
    operation: string,
    legacyOperation?: string,
  ): Awaitable<{ safe: boolean; code: string; delay: number }>;
  retrySafe(key: string): Awaitable<boolean>;
  retryAfter(key: string): Awaitable<number>;
  claim(
    key: string,
    operation: string,
    metadata: Parameters<WorkspaceCache["claim"]>[2],
  ): Awaitable<string | null>;
  evidence(key: string, token: string, event: GenerationEvidence): Awaitable<void>;
  checkpoint(key: string, token: string, notebook: Notebook): Awaitable<void>;
  finish(key: string, token: string, notebook: Notebook): Awaitable<void>;
  fail(
    key: string,
    token: string,
    code: string,
    retryable: boolean,
    retryAfterSeconds?: number,
  ): Awaitable<void>;
  cancelBeforeSend(key: string, token: string): Awaitable<void>;
}
/** Server-only RPCs. No request principal, content or credentials are exposed as job IDs. */
export class PostgresGenerationStore implements GenerationStore {
  constructor(private rpc: typeof learningRpc = learningRpc) {}
  private call(
    key: string,
    operation: string,
    action: string,
    token: string | null = null,
    value: unknown = {},
  ) {
    return this.rpc("study_generation", {
      p_key: key,
      p_operation: operation,
      p_action: action,
      p_token: token,
      p_value: value,
    });
  }
  async material(key: string) {
    const result = z
      .object({ notebook: notebookSchema.optional() })
      .parse(await this.call(key, key, "read"));
    return result.notebook ?? null;
  }
  async checkState(key: string, operation: string) {
    return z
      .object({ safe: z.boolean(), code: z.string(), delay: z.number().int().nonnegative() })
      .parse(await this.call(key, operation, "check"));
  }
  async retrySafe(key: string) {
    return (await this.checkState(key, key)).safe;
  }
  async retryAfter(key: string) {
    return Math.max(1, (await this.checkState(key, key)).delay);
  }
  async claim(key: string, operation: string, metadata: Parameters<WorkspaceCache["claim"]>[2]) {
    const result = z
      .object({
        status: z.enum(["ready", "reserved", "blocked", "cooldown", "exhausted"]),
        token: z.uuid().optional(),
      })
      .parse(await this.call(key, operation, "claim", null, { leaseMs: metadata?.leaseMs }));
    if (result.status === "exhausted")
      throw new AppError(
        "The bounded retry limit has been reached. Contact support before another generation.",
        { code: "GENERATION_RETRY_LIMIT", statusCode: 409 },
      );
    return result.token ?? null;
  }
  private async update(key: string, token: string, action: string, value?: unknown) {
    // Updates lock the same operation as claim, looked up by the SQL function.
    const result = await this.call(key, key, action, token, value ?? {});
    if (!z.object({ ok: z.literal(true) }).safeParse(result).success)
      throw new AppError("Generation persistence could not be confirmed.", {
        code: "JOB_LEASE_LOST",
        statusCode: 503,
      });
  }
  evidence(key: string, token: string, event: GenerationEvidence) {
    return this.update(key, token, "evidence", event);
  }
  checkpoint(key: string, token: string, notebook: Notebook) {
    return this.update(key, token, "checkpoint", notebookSchema.parse(notebook));
  }
  finish(key: string, token: string, _notebook: Notebook) {
    return this.update(key, token, "finish");
  }
  fail(key: string, token: string, code: string, _retryable: boolean, retryAfterSeconds = 60) {
    return this.update(key, token, "fail", { code, retryAfterSeconds });
  }
  cancelBeforeSend(key: string, token: string) {
    return this.update(key, token, "cancel");
  }
}
