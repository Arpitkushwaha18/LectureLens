import { randomUUID } from "node:crypto";
import { parseYouTubeUrl, videoVerificationSchema } from "@lecturelens/contracts";
import { AppError } from "../lib/errors.js";

/** URL validation only. Never contact YouTube, TranscriptFetch or storage here.
 * A valid URL does not promise that the provider can retrieve its transcript. */
export function createVideoVerifier() {
  const receipts = new Map<string, { videoId: string; expires: number }>();
  return {
    async verify(input: unknown) {
      const source = parseYouTubeUrl(input);
      for (const [key, receipt] of receipts) if (receipt.expires < Date.now()) receipts.delete(key);
      if (receipts.size >= 2000) receipts.delete(receipts.keys().next().value!);
      const token = randomUUID();
      receipts.set(token, { videoId: source.videoId, expires: Date.now() + 600000 });
      return videoVerificationSchema.parse({
        status: "verified",
        videoId: source.videoId,
        verificationToken: token,
        message: "YouTube URL is valid.",
      });
    },
    assert(token: string | undefined, videoId: string) {
      const receipt = token ? receipts.get(token) : undefined;
      if (!receipt || receipt.expires < Date.now() || receipt.videoId !== videoId)
        throw new AppError("Please validate this YouTube URL again before continuing.", {
          code: "VIDEO_VERIFICATION_REQUIRED",
          statusCode: 400,
        });
    },
  };
}
export const videoVerifier = createVideoVerifier();
