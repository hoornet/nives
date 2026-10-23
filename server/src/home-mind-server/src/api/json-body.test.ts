import { describe, it, expect } from "vitest";
import express from "express";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { JSON_BODY_OPTIONS } from "./json-body.js";

// The JSON parser runs before the token check, so whatever it does to a body,
// anyone who can reach the port can make it do. With body-parser's defaults
// that included decompressing it: CVE-2026-111497, a flaw in Node's Brotli
// decoder, was reachable that way with no token. Both halves are tested: that
// our options refuse a compressed body before any handler, and that the
// defaults would have decompressed it, so the option cannot be dropped as
// redundant once Node is patched.

const BODY = JSON.stringify({ message: "Koliko je ura?" });

/** Post one body to a throwaway server parsing JSON with the given options. */
async function post(options: Parameters<typeof express.json>[0], body: string | Buffer, encoding?: string) {
  let reached = false;
  const app = express();
  app.post("/", express.json(options), (req: express.Request, res: express.Response) => {
    reached = true;
    res.json(req.body);
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (encoding) headers["content-encoding"] = encoding;
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers, body });
    return { status: res.status, reached, text: await res.text() };
  } finally {
    server.close();
  }
}

describe("JSON body parser options", () => {
  it("parses a plain JSON body", async () => {
    const res = await post(JSON_BODY_OPTIONS, BODY);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ message: "Koliko je ura?" });
  });

  it.each([
    ["br", brotliCompressSync(BODY)],
    ["gzip", gzipSync(BODY)],
    ["deflate", deflateSync(BODY)],
  ])("refuses a %s body with 415 before any handler", async (encoding, body) => {
    const res = await post(JSON_BODY_OPTIONS, body, encoding);
    expect(res.status).toBe(415);
    expect(res.reached).toBe(false);
  });

  it("proves body-parser's defaults would have decompressed it", async () => {
    // Same parser, same limit, inflate left at its default: the Brotli body
    // is decoded and handed to the route.
    const res = await post({ limit: JSON_BODY_OPTIONS.limit }, brotliCompressSync(BODY), "br");
    expect(res.status).toBe(200);
    expect(res.reached).toBe(true);
  });
});
