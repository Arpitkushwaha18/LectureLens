import { AsyncLocalStorage } from "node:async_hooks";
export type GenerationEvidence = {
  kind: "dispatch" | "response" | "validated" | "failure" | "not_sent";
  httpStatus?: number;
  requestId?: string;
  classification?: string;
  retryAfterSeconds?: number;
};
const context = new AsyncLocalStorage<(event: GenerationEvidence) => void | Promise<void>>();
export function withGenerationEvidence<T>(
  record: (event: GenerationEvidence) => void | Promise<void>,
  work: () => Promise<T>,
) {
  return context.run(record, work);
}
export async function recordGenerationEvidence(event: GenerationEvidence) {
  await context.getStore()?.(event);
}
