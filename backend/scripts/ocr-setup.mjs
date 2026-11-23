import { mkdir, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("../.cache/tessdata/", import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const language of ["eng", "hin", "osd"]) {
  const file = new URL(`../.cache/tessdata/${language}.traineddata`, import.meta.url);
  if (
    await access(file).then(
      () => true,
      () => false,
    )
  ) {
    console.log(`${language}: already provisioned`);
    continue;
  }
  const response = await fetch(
    `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/${language}.traineddata`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) throw new Error(`Language download failed (${response.status})`);
  await writeFile(file, new Uint8Array(await response.arrayBuffer()), { mode: 0o600, flag: "wx" });
  console.log(`${language}: provisioned locally (free tessdata_fast)`);
}
console.log(
  "Tesseract binary is a separate system prerequisite: macOS brew install tesseract; Debian/Ubuntu apt install tesseract-ocr.",
);
