import { mkdir, copyFile } from "node:fs/promises";

// PDF export must not depend on the frontend source tree existing at runtime.
const target = new URL("../dist/assets/", import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(
  new URL("../../frontend/src/features/notebook/notebook.css", import.meta.url),
  new URL("notebook.css", target),
);
for (const name of ["STIXTwoMath-Regular.woff2", "OFL.txt"]) {
  await copyFile(
    new URL(`../../frontend/src/features/notebook/fonts/${name}`, import.meta.url),
    new URL(name, target),
  );
}
