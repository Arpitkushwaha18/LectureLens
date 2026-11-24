import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { z } from "zod";
import { resourceToNotebook, type PublishPermission } from "@lecturelens/contracts";
import { publishResource, readResource } from "@/features/library/resources-api";
import { NotebookResults } from "@/features/notebook/NotebookResults";
import { Button } from "@/components/ui/Button";

export function ResourcePage() {
  const { id } = useParams(),
    [publishError, setError] = useState("");
  const [publishing, setPublishing] = useState(false),
    client = useQueryClient();
  const query = useQuery({
    queryKey: ["resource", id],
    queryFn: ({ signal }) => readResource(id!, signal),
    enabled: z.uuid().safeParse(id).success,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const resource = query.data,
    error = !z.uuid().safeParse(id).success
      ? "Resource not found."
      : publishError || query.error?.message;
  async function publish(form: HTMLFormElement) {
    if (!resource || publishing) return;
    const values = new FormData(form);
    setPublishing(true);
    setError("");
    try {
      const published = await publishResource(resource.id, {
        basis: String(values.get("basis")) as PublishPermission["basis"],
        statement: String(values.get("statement")),
        confirmRights: true,
        confirmPlatformTerms: true,
      });
      client.setQueryData(["resource", id], published);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Publishing failed.");
    } finally {
      setPublishing(false);
    }
  }
  return (
    <section className="mx-auto max-w-5xl">
      <Link className="text-sm text-navy underline" to="/gallery">
        ← Notes Gallery
      </Link>
      {error ? (
        <div role="alert" className="my-4">
          <p>{error}</p>
          {!resource ? (
            <Button className="mt-2" onClick={() => void query.refetch()}>
              Retry loading
            </Button>
          ) : null}
        </div>
      ) : null}
      {!resource && !error ? (
        <p role="status" className="mt-5">
          Opening your study material…
        </p>
      ) : null}
      {resource ? (
        <>
          <p className="mt-5 text-sm text-ink-muted">
            {resource.visibility === "private"
              ? "Private resource · only you can read this"
              : "Published resource · shared with everyone"}
          </p>
          <NotebookResults
            key={resource.id}
            content={resource.content}
            result={{
              status: "ready",
              source:
                resource.sourceType === "youtube"
                  ? {
                      kind: "youtube",
                      name: resource.title,
                      language: resource.sourceLanguage,
                      warnings: [],
                    }
                  : {
                      kind: resource.sourceType,
                      name: resource.title,
                      text: "Original source is private.",
                      language: resource.sourceLanguage,
                      warnings: [],
                    },
              materials: [
                {
                  outputType: resource.outputType,
                  notebook: resourceToNotebook(resource.content),
                  resourceId: resource.id,
                  visibility: resource.visibility,
                  cached: true,
                  language: resource.language,
                },
              ],
            }}
          />
          {resource.owned && resource.visibility === "private" ? (
            <form
              className="paper-panel mt-8 p-5"
              onSubmit={(e) => {
                e.preventDefault();
                void publish(e.currentTarget);
              }}
            >
              <h2 className="text-xl">Share on the study shelf</h2>
              <p className="mt-2 text-xs text-ink-soft">
                Publishing makes this generated resource public. Raw source documents, transcript
                text and private attempts are not published.
              </p>
              <label className="mt-4 block text-sm">
                Permission basis{" "}
                <select name="basis" className="ml-2 rounded border border-rule bg-surface p-2">
                  <option value="own_work">My own work</option>
                  <option value="licensed">Licensed material</option>
                  <option value="permission">Rights-holder permission</option>
                  <option value="public_domain">Public domain</option>
                </select>
              </label>
              <label className="mt-4 block text-sm">
                Rights statement
                <textarea
                  name="statement"
                  required
                  minLength={1}
                  maxLength={1000}
                  className="mt-2 block w-full rounded border border-rule bg-surface p-3"
                  placeholder="Explain why you can share this material."
                />
              </label>
              <label className="mt-4 flex items-start gap-2 text-sm">
                <input type="checkbox" required />I have permission to publish this material.
              </label>
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input type="checkbox" required />
                Sharing complies with source platform terms.
              </label>
              <Button type="submit" className="mt-4" disabled={publishing}>
                {publishing ? "Publishing…" : "Publish resource"}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
