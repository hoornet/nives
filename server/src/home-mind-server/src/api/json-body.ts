/**
 * Options for the JSON parser in front of the whole API.
 *
 * The parser runs before the token check (index.ts), so whatever it does to a
 * body, anyone who can reach the port can make it do. Left at its default,
 * body-parser decompresses gzip, deflate and Brotli bodies, which put Node's
 * decoders in front of the token: CVE-2026-111497, a Brotli decoder flaw fixed
 * in Node 22.23.4, was reachable that way with no token at all. The Home
 * Assistant integration posts plain JSON, and so does every client that goes
 * through Home Assistant, so `inflate: false` refuses a compressed body with
 * 415 before any decoder sees it.
 *
 * 20mb so base64-encoded camera snapshots (images on /api/chat) aren't rejected
 * by the 100kb default. Aligns with the 25mb multer limit used for audio uploads.
 */
export const JSON_BODY_OPTIONS = { limit: "20mb", inflate: false } as const;
