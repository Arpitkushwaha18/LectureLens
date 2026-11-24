import { z } from "zod";
import {
  resourceListSchema,
  resourceSchema,
  quizAttemptSchema,
  publishPermissionSchema,
  type PublishPermission,
} from "@lecturelens/contracts";
import { libraryRequest } from "./library-api";

export async function listResources(filters: Record<string, string>, signal?: AbortSignal) {
  const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ""));
  return z
    .object({ data: resourceListSchema })
    .parse(await libraryRequest(`/resources?${params}`, { signal })).data;
}
export async function readResource(id: string, signal?: AbortSignal) {
  return z
    .object({ data: resourceSchema })
    .parse(await libraryRequest(`/resources/${id}`, { signal })).data;
}
export async function publishResource(id: string, permission: PublishPermission) {
  return z.object({ data: resourceSchema }).parse(
    await libraryRequest(`/resources/${id}/publish`, {
      method: "POST",
      body: JSON.stringify(publishPermissionSchema.parse(permission)),
    }),
  ).data;
}
export async function submitQuiz(id: string, submissionId: string, answers: (number | null)[]) {
  return z.object({ data: quizAttemptSchema }).parse(
    await libraryRequest(`/resources/${id}/attempts`, {
      method: "POST",
      body: JSON.stringify({ submissionId, answers }),
    }),
  ).data;
}
export async function quizAttempts(id: string, signal?: AbortSignal) {
  return z
    .object({ data: z.array(quizAttemptSchema) })
    .parse(await libraryRequest(`/resources/${id}/attempts`, { signal })).data;
}
