import type { LaunchOptions } from "playwright";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** Render/Linux uses a packaged headless browser and its native libraries, not a build cache. */
export async function pdfBrowserOptions(): Promise<LaunchOptions> {
  if (process.platform !== "linux") return { headless: true };
  const { default: bundled, inflate } = await import("@sparticuz/chromium");
  bundled.setGraphicsMode = false;
  // Render is not AWS, so explicitly unpack the packaged NSS/native libraries.
  const require = createRequire(import.meta.url);
  const libraries = join(dirname(require.resolve("@sparticuz/chromium")), "../bin/al2023.tar.br");
  const [executablePath] = await Promise.all([bundled.executablePath(), inflate(libraries)]);
  return {
    headless: true,
    executablePath,
    args: bundled.args.filter(
      (arg) => !["--disable-web-security", "--allow-running-insecure-content"].includes(arg),
    ),
    env: {
      ...process.env,
      FONTCONFIG_PATH: join(tmpdir(), "fonts"),
      LD_LIBRARY_PATH: [join(tmpdir(), "al2023/lib"), process.env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(":"),
    },
  };
}
