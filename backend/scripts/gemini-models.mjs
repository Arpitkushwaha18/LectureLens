import { config } from "dotenv";
import { fileURLToPath } from "node:url";
config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });
import { GoogleGenAI } from "@google/genai";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("Set GEMINI_API_KEY locally in backend/.env first. No key is printed.");
  process.exitCode = 1;
} else {
  try {
    const client = new GoogleGenAI({
      apiKey: key,
      // Pin the same Developer API as the backend, regardless of SDK env flags.
      vertexai: false,
      enterprise: false,
      apiVersion: "v1beta",
      httpOptions: {
        baseUrl: "https://generativelanguage.googleapis.com/",
        timeout: 15000,
        retryOptions: { attempts: 1 },
      },
    });
    const models = await client.models.list({ config: { pageSize: 100 } });
    for await (const model of models) {
      if (model.supportedActions?.includes("generateContent")) {
        console.log(
          `${model.name?.replace(/^models\//, "")} | input=${model.inputTokenLimit} output=${model.outputTokenLimit}`,
        );
      }
    }
    console.log(
      "Choose a text/structured-output model from this list in GEMINI_MODEL. Listing does not generate content; capacity and access are checked again before generation.",
    );
  } catch {
    console.error(
      "Model availability check failed. Check the local key, API access and network. Upstream errors are not printed.",
    );
    process.exitCode = 1;
  }
}
