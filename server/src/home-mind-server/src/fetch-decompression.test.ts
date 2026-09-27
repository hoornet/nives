import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import tls from "node:tls";
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
 * certificate that is trusted for the test (validation stays on), so it needs
 * no network and no key. Plain HTTP or HTTP/1.1 TLS
 * would NOT catch it: both decoded correctly on the broken version.
 */
describe("Node fetch with undici loaded", () => {
  let server: Http2SecureServer | undefined;
  let url: string;
  let dir: string | undefined;
  let previousCAs: string[] | undefined;
  const payload = { text: "Koliko je ura?" };

  beforeAll(async () => {
    void WebSocket;
    void Agent;
    // A fresh self-signed certificate per run: nothing secret is ever committed.
    dir = mkdtempSync(join(tmpdir(), "nives-h2-"));
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      { stdio: "ignore" }
    );
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    server = createSecureServer(
      { key: readFileSync(join(dir, "key.pem")), cert, allowHTTP1: true },
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(JSON.stringify(payload)));
      }
    );
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    url = `https://127.0.0.1:${(listening.address() as AddressInfo).port}/`;
    // Only fetch's default path shows the bug, so a custom dispatcher would test
    // the wrong thing. Trust this one certificate instead, keeping certificate
    // validation fully on: the throwaway cert joins the default CA set.
    previousCAs = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...previousCAs, cert]);
  });

  afterAll(async () => {
    if (previousCAs) tls.setDefaultCACertificates(previousCAs);
    const running = server;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("decompresses a gzip response served over HTTP/2", async () => {
    const res = await fetch(url);
    expect(await res.json()).toEqual(payload);
  });
});
