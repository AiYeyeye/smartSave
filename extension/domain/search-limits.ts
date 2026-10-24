export const AI_SEARCH_CANDIDATES = 80;
/** Bookmark search checks the whole permitted catalog; this is only a request size. */
export const BOOKMARK_SEARCH_BATCH_SIZE = 100;
/** Planning is optional: never let it hold up the first bookmark batch indefinitely. */
export const SEARCH_PLAN_TIMEOUT_MS = 5_000;
export const SEARCH_FOLDER_SAMPLES = 3;
export const SEARCH_FOLDER_SAMPLE_CHARS = 100;
export const SEARCH_FOLDER_CHUNK = 25;
export const SEARCH_LOCAL_PRIORITY = 20;
/** History ranking only; bookmark search preserves every returned match. */
export const AI_SEARCH_RESULTS = 20;
export const AI_SEARCH_TERMS = 12;
export const AI_SEARCH_TERM_CHARS = 64;
