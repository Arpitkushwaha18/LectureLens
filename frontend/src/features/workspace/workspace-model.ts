import {
  generationSelectionV2Schema,
  MAX_UPLOAD_BYTES,
  parseYouTubeUrl,
  youtubeUrlInputSchema,
  type CanonicalVideoSource,
  type GenerationOutputTypeV2,
} from "@lecturelens/contracts";

export type WorkspaceSourceType = "youtube" | "pdf" | "spreadsheet";
export type FileSourceType = Exclude<WorkspaceSourceType, "youtube">;
export type LocalFileMetadata = Pick<File, "name" | "size" | "type">;

export const MAX_LOCAL_FILE_BYTES = MAX_UPLOAD_BYTES;

const MIME_TYPES: Record<string, readonly string[]> = {
  pdf: ["application/pdf"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  xls: ["application/vnd.ms-excel"],
  csv: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"],
};

export function getYouTubeSource(url: string): CanonicalVideoSource | null {
  const input = youtubeUrlInputSchema.safeParse({ url });
  return input.success ? parseYouTubeUrl(input.data.url) : null;
}

/** Metadata checks only. Does not read, upload, parse or persist file contents. */
export function validateLocalFile(file: LocalFileMetadata, source: FileSourceType): string | null {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const allowedExtensions = source === "pdf" ? ["pdf"] : ["xlsx", "xls", "csv"];
  if (!file.name.includes(".") || !extension || !allowedExtensions.includes(extension)) {
    return source === "pdf" ? "Choose a .pdf file." : "Choose an .xlsx, .xls or .csv file.";
  }
  const mime = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!mime || !MIME_TYPES[extension]?.includes(mime)) {
    return "The file type does not match its extension, or your browser could not identify it. Choose another file.";
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    return "This file is empty or has an invalid size. Choose a non-empty file.";
  }
  if (file.size > MAX_LOCAL_FILE_BYTES) {
    return "Choose a file no larger than 20 MB.";
  }
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isWorkspaceReady(
  source: WorkspaceSourceType,
  url: string,
  file: LocalFileMetadata | null,
  outputTypes: readonly GenerationOutputTypeV2[],
): boolean {
  const validSource =
    source === "youtube"
      ? getYouTubeSource(url) !== null
      : file !== null && validateLocalFile(file, source) === null;
  return (
    validSource && generationSelectionV2Schema.safeParse({ schemaVersion: 2, outputTypes }).success
  );
}
