/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the LectureLens API, including the version prefix. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
