import { describe, it, expect } from "vitest";
import express from "express";
import multer from "multer";
import type { AddressInfo } from "node:net";
import { UPLOAD_LIMITS } from "./routes.js";

// GHSA-535w-7cp7-47q4: a crafted multipart field name such as `items[4294967294]`
// makes append-field allocate a maximum-length sparse array, and a second field on
// the same base converts it by walking the whole length — one request, synchronous,
// and the process answers nothing else.
//
// The trap is that upgrading multer does NOT fix this on its own. The option
// defaults to Infinity and is only enforced when the key is present, so a
// well-meaning cleanup that drops it as "redundant next to the bump" silently
// reopens the hole. Both halves are tested: that real multer rejects the payload
// under our limits, and that the key survives in the constant.

const ATTACK = "items[4294967294]";

/** Post one multipart field to a throwaway server using the given limits. */
async function postField(limits: multer.Options["limits"], name: string) {
  const app = express();
  app.post(
    "/",
    multer({ storage: multer.memoryStorage(), limits }).single("audio"),
    (_req: express.Request, res: express.Response) => res.json({ ok: true }),
    (err: { code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(400).json({ code: err.code })
  );
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=X" },
      body: `--X\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n1\r\n--X--\r\n`,
    });
    return { status: res.status, body: (await res.json()) as { ok?: boolean; code?: string } };
  } finally {
    server.close();
  }
}

describe("multipart upload limits (GHSA-535w-7cp7-47q4)", () => {
  it("rejects an oversized array index in a field name", async () => {
    const res = await postField({ ...UPLOAD_LIMITS }, ATTACK);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LIMIT_FIELD_ARRAY_INDEX");
  });

  it("proves the version bump alone would not have done it", async () => {
    // Same multer, same payload, limit omitted — accepted. This is why the
    // option cannot be treated as redundant next to the dependency bump.
    const res = await postField({ fileSize: UPLOAD_LIMITS.fileSize }, ATTACK);
    expect(res.status).toBe(200);
  });

  it("still accepts the fields this endpoint actually uses", async () => {
    // `audio` and `language` carry no brackets, so a limit of 0 breaks no caller.
    const res = await postField({ ...UPLOAD_LIMITS }, "language");
    expect(res.status).toBe(200);
  });

  it("keeps the key present, since multer only enforces what is explicitly set", () => {
    expect(Object.prototype.hasOwnProperty.call(UPLOAD_LIMITS, "fieldArrayIndexLimit")).toBe(true);
    expect(UPLOAD_LIMITS.fieldArrayIndexLimit).toBe(0);
  });

  it("still caps the upload size", () => {
    expect(UPLOAD_LIMITS.fileSize).toBe(25 * 1024 * 1024);
  });
});
