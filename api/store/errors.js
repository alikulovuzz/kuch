/* What a storage backend throws that a caller may answer differently from a bug (store/index.js). */

// The database cannot be reached right now (refused, dropped, timed out, shutting down): the
// request may succeed if retried, so the API answers 503 rather than 500.
export class StoreUnavailable extends Error {
  constructor(cause) {
    super('database unavailable: ' + (cause?.message || cause));
    this.name = 'StoreUnavailable';
    this.cause = cause;
  }
}

// A training document the backend cannot store as it is: in Postgres, a string holding the NUL
// character (U+0000) or a lone surrogate, which JSONB refuses. A bad request, answered 400 — the
// same as a document nested too deep to serialise — and never stored with the character stripped.
export class InvalidDocument extends Error {
  constructor(cause) {
    super('document cannot be stored: ' + (cause?.message || cause));
    this.name = 'InvalidDocument';
    this.cause = cause;
  }
}
