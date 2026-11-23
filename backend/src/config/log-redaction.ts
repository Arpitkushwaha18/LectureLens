export const logRedaction = {
  paths: [
    "req.headers.authorization",
    "req.headers.apikey",
    "req.headers['x-goog-api-key']",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  censor: "[REDACTED]",
};
