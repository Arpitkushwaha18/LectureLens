import "dotenv/config";
import { readFile } from "node:fs/promises";
import { workspaceCache } from "../dist/repositories/workspace-cache.js";
// Operator-only local import of actual curated notes. No demo/default content.
const [file, videoId] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/gallery-import.mjs notebook.json [youtube-video-id]");
  process.exitCode = 1;
} else {
  try {
    console.log(
      `Imported gallery note ${workspaceCache().publishGallery(JSON.parse(await readFile(file, "utf8")), videoId)}`,
    );
  } catch {
    console.error(
      "Import failed. Provide validated notebook JSON and an optional exact YouTube video ID.",
    );
    process.exitCode = 1;
  }
}
