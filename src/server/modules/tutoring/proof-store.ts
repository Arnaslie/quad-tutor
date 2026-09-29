import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { del, get, put } from "@vercel/blob";

export type StoredProof = { body: ReadableStream<Uint8Array>; contentType: string };

export type ProofStore = {
  put(pathname: string, body: Uint8Array, contentType: string): Promise<void>;
  get(pathname: string): Promise<StoredProof | null>;
  del(pathnames: string[]): Promise<void>;
};

const vercelBlob: ProofStore = {
  async put(pathname, body, contentType) {
    await put(pathname, Buffer.from(body), {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
    });
  },
  async get(pathname) {
    const result = await get(pathname, { access: "private", useCache: false });
    if (result?.statusCode !== 200) return null;
    return { body: result.stream, contentType: result.blob.contentType };
  },
  async del(pathnames) {
    if (pathnames.length > 0) await del(pathnames);
  },
};

const LOCAL_ROOT = path.join(process.cwd(), ".proof-store");

function localPath(pathname: string): string {
  const resolved = path.resolve(LOCAL_ROOT, pathname);
  if (!resolved.startsWith(LOCAL_ROOT + path.sep)) throw new Error("Bad proof pathname.");
  return resolved;
}

const localDisk: ProofStore = {
  async put(pathname, body, contentType) {
    const file = localPath(pathname);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, { flag: "wx" });
    await writeFile(`${file}.type`, contentType);
  },
  async get(pathname) {
    const file = localPath(pathname);
    try {
      const [body, contentType] = await Promise.all([
        readFile(file),
        readFile(`${file}.type`, "utf8"),
      ]);
      return { body: new Blob([body]).stream(), contentType };
    } catch {
      return null;
    }
  },
  async del(pathnames) {
    for (const pathname of pathnames) {
      const file = localPath(pathname);
      await rm(file, { force: true });
      await rm(`${file}.type`, { force: true });
    }
  },
};

export function proofStore(): ProofStore {
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) return vercelBlob;
  if (process.env.NODE_ENV === "production") {
    throw new Error("No private Blob store is connected — refusing to keep transcripts on disk.");
  }
  return localDisk;
}
