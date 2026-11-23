import yauzl from "yauzl";
import { posix } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { ocrError } from "./ocr.js";
type Image = { name: string; sheet: string; location?: string; bytes: Buffer };
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  processEntities: false,
});
const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
function target(base: string, path: string): string {
  const name = posix.normalize(
    path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(base), path),
  );
  if (!name.startsWith("xl/") || name.includes(".."))
    throw ocrError("Workbook image relationship is outside the supported archive.");
  return name;
}
const relName = (name: string) =>
  posix.join(posix.dirname(name), "_rels", posix.basename(name) + ".rels");
export async function workbookImages(
  bytes: Buffer,
): Promise<{ images: Image[]; warnings: string[] }> {
  const entries = await new Promise<Map<string, Buffer>>((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(ocrError("Invalid XLSX archive."));
        return;
      }
      const values = new Map<string, Buffer>();
      let expanded = 0,
        count = 0;
      zip.on("error", () => reject(ocrError("Corrupt XLSX archive.")));
      zip.on("end", () => resolve(values));
      zip.on("entry", (entry) => {
        expanded += entry.uncompressedSize;
        count++;
        if (expanded > 40 * 1024 * 1024 || count > 2000 || entry.generalPurposeBitFlag & 1) {
          zip.close();
          reject(ocrError("Workbook exceeds decompression limits or is encrypted."));
          return;
        }
        if (!/^xl\/(.*\.xml(\.rels)?|.*\.rels|media\/[^/]+)$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(ocrError("Unreadable XLSX entry."));
            zip.close();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk) => {
            size += chunk.length;
            if (size > 40 * 1024 * 1024) {
              stream.destroy();
              zip.close();
              reject(ocrError("Workbook entry exceeds decompression limits."));
            } else chunks.push(chunk);
          });
          stream.on("error", () => reject(ocrError("Corrupt XLSX entry.")));
          stream.on("end", () => {
            values.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    }),
  );
  const xml = (name: string) => {
    const content = entries.get(name);
    if (!content) return {};
    if (content.includes(Buffer.from("<!DOCTYPE")))
      throw ocrError("XML document types are unsupported in workbook images.");
    return parser.parse(content.toString("utf8"));
  };
  let externalLinks = false;
  const relationships = (name: string) =>
    new Map<string, string>(
      array<Record<string, string>>(xml(relName(name)).Relationships?.Relationship)
        .filter((rel) => {
          if (rel.TargetMode === "External") {
            externalLinks = true;
            return false;
          }
          return rel.Id && rel.Target;
        })
        .map((rel) => [rel.Id!, target(name, rel.Target!)]),
    );
  const book = xml("xl/workbook.xml"),
    bookRels = relationships("xl/workbook.xml"),
    images: Image[] = [];
  const mapped = new Set<string>();
  for (const sheet of array<Record<string, string>>(book.workbook?.sheets?.sheet)) {
    const sheetPath = bookRels.get(sheet.id || "");
    if (!sheetPath) continue;
    const sheetXml = xml(sheetPath),
      sheetRels = relationships(sheetPath);
    for (const drawing of array<Record<string, string>>(sheetXml.worksheet?.drawing)) {
      const drawingPath = sheetRels.get(drawing.id || "");
      if (!drawingPath) continue;
      const imageRels = relationships(drawingPath),
        drawingXml = xml(drawingPath).wsDr || {};
      for (const anchor of [
        ...array(drawingXml.twoCellAnchor),
        ...array(drawingXml.oneCellAnchor),
        ...array(drawingXml.absoluteAnchor),
      ]) {
        const embed = anchor.pic?.blipFill?.blip?.embed,
          path = imageRels.get(embed);
        if (!path || !entries.has(path)) continue;
        mapped.add(path);
        const row = Number(anchor.from?.row),
          col = Number(anchor.from?.col);
        images.push({
          name: posix.basename(path),
          sheet: sheet.name || "Unnamed sheet",
          ...(Number.isFinite(row) && Number.isFinite(col)
            ? { location: `Row ${row + 1}, column ${col + 1}` }
            : {}),
          bytes: entries.get(path)!,
        });
      }
    }
  }
  const unmapped = [...entries.keys()].filter(
    (name) => name.startsWith("xl/media/") && !mapped.has(name),
  ).length;
  return {
    images,
    warnings: [
      ...(unmapped
        ? [
            `${unmapped} workbook media item(s) have unsupported or unassociated drawing anchors; grouped, chart and rich-data/in-cell images may not be extracted.`,
          ]
        : []),
      ...(externalLinks
        ? ["External workbook relationships were ignored. Linked images are never fetched."]
        : []),
    ],
  };
}
