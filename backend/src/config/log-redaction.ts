export const logRedaction = {
  paths: [
    "GROQ_API_KEY",
    "FREEGG_API_KEY",
    "*.GROQ_API_KEY",
    "*.FREEGG_API_KEY",
    "apiKey",
    "*.apiKey",
    "req.headers.authorization",
    "req.headers.apikey",
    "req.headers['x-goog-api-key']",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  censor: "[REDACTED]",
};
