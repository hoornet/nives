import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
// Imported for its side effects on the process, exactly as the server does
// (ha/exposed-entities.ts and ha/client.ts load it at startup).
import { WebSocket, Agent } from "undici";

/**
 * Loading the undici package must not break Node's own fetch.
 *
 * undici 8.11.0 did: once it was imported, the built-in fetch spoke HTTP/2 to
 * servers that offer it, and on that path handed back gzip bodies undecoded
 * with the content-encoding header removed. Every non-streaming call to such a
 * server (anything behind Cloudflare, for one, offers HTTP/2) got
 * garbage: transcriptions came back empty because the SDK found no JSON and so
 * no `text`, and the balance check failed with `Unexpected token ''`. It
 * shipped in 2.6.6 and 2.6.7, because nothing here fetched a compressed
 * response over HTTP/2. This does, from a local server with a throwaway
 * certificate, so it needs no network and no key. Plain HTTP or HTTP/1.1 TLS
 * would NOT catch it: both decoded correctly on the broken version.
 */
describe("Node fetch with undici loaded", () => {
  let server: Http2SecureServer;
  let url: string;
  let dir: string;
  let previousTls: string | undefined;
  const payload = { text: "Koliko je ura?" };

  beforeAll(async () => {
    void WebSocket;
    void Agent;
    // A fresh self-signed certificate per run: nothing secret is ever committed.
    dir = mkdtempSync(join(tmpdir(), "nives-h2-"));
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      { stdio: "ignore" }
    );
    server = createSecureServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")), allowHTTP1: true },
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(JSON.stringify(payload)));
      }
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    // Only the default fetch path shows the bug, so the certificate is accepted
    // process-wide for this test rather than through a custom dispatcher.
    previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  });

  afterAll(async () => {
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("decompresses a gzip response served over HTTP/2", async () => {
    const res = await fetch(url);
    expect(await res.json()).toEqual(payload);
  });
});
