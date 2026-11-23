import { config } from "dotenv";
import { fileURLToPath } from "node:url";
/** Resolve relative to backend source/dist, never the shell's working directory. Shell values win. */
export const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export function loadBackendEnvironment() {
  config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
}
loadBackendEnvironment();
