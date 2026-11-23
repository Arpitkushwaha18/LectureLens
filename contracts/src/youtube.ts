import { z } from "zod";

export const CONTRACT_SCHEMA_VERSION = 1;
export const MAX_YOUTUBE_URL_LENGTH = 2048;

export const youtubeVideoIdSchema = z
  .string()
  .length(11)
  .regex(/^[A-Za-z0-9_-]{11}$/u, {
    error: "A YouTube video ID must contain exactly 11 letters, digits, underscores or hyphens",
  });

const LONG_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * Pure parsing only: no network access, redirects, metadata lookup or provider dependency.
 * Check the raw syntax as well as URL's result: WHATWG URL parsing silently repairs
 * backslashes, dot segments, default ports and some otherwise malformed inputs.
 */
function extractVideoId(input: string): string | undefined {
  if (
    /[\s\\]/u.test(input) ||
    Array.from(input).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    /%(?![A-Fa-f0-9]{2})/u.test(input)
  ) {
    return undefined;
  }

  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/iu.exec(input);
  if (!match) return undefined;

  const authority = match[1]?.toLowerCase();
  const rawPath = match[2] ?? "/";
  // Reject credentials, ports, encoded/Unicode hosts and lookalikes before normalization.
  if (!authority || (!LONG_HOSTS.has(authority) && authority !== "youtu.be")) {
    return undefined;
  }
  if (rawPath.includes("%") || rawPath.split("/").some((part) => part === "." || part === "..")) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }

  let videoId: string | undefined;
  if (LONG_HOSTS.has(authority) && url.pathname === "/watch") {
    const ids = url.searchParams.getAll("v");
    if (ids.length !== 1) return undefined;
    videoId = ids[0];
  } else {
    // A second video identifier in the query is ambiguous on path-based formats.
    if (url.searchParams.has("v")) return undefined;
    const pathMatch =
      authority === "youtu.be"
        ? /^\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname)
        : /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/u.exec(url.pathname);
    videoId = pathMatch?.[1];
  }

  return youtubeVideoIdSchema.safeParse(videoId).success ? videoId : undefined;
}

/** Validates a URL string; trims outer whitespace but preserves accepted parameters. */
export const youtubeUrlSchema = z
  .string()
  .max(MAX_YOUTUBE_URL_LENGTH)
  .trim()
  .min(1)
  .superRefine((input, context) => {
    if (!extractVideoId(input)) {
      context.addIssue({
        code: "custom",
        message: "Enter a supported HTTPS YouTube video URL with a valid video ID",
      });
    }
  });

export const youtubeUrlInputSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION).default(CONTRACT_SCHEMA_VERSION),
  url: youtubeUrlSchema,
});

export const canonicalVideoSourceSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    kind: z.literal("youtube"),
    videoId: youtubeVideoIdSchema,
    canonicalUrl: z.string(),
  })
  .refine((source) => source.canonicalUrl === `https://www.youtube.com/watch?v=${source.videoId}`, {
    path: ["canonicalUrl"],
    error: "Canonical URL must match the video ID exactly",
  });

export type YouTubeUrlInput = z.input<typeof youtubeUrlInputSchema>;
export type CanonicalVideoSource = z.infer<typeof canonicalVideoSourceSchema>;

/** Returns an identity URL, deliberately dropping timestamps, playlists and tracking. */
export function parseYouTubeUrl(input: unknown): CanonicalVideoSource {
  const url = youtubeUrlSchema.parse(input);
  const videoId = extractVideoId(url);
  // The public schema guarantees this; keep the invariant explicit for strict TypeScript.
  if (!videoId) throw new Error("Validated YouTube URL did not contain a video ID");
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: "youtube",
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
