import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordedImage } from "../adapter/contract.js";

/** A session's own content-addressed files: capped on decoded bytes, oldest first, retained across restarts. */
export const createTranscriptImages = (root: string, maxBytes = 200 * 1024 * 1024) => {
  const directory = (sessionId: string) => join(root, createHash("sha256").update(sessionId).digest("hex"));
  const store = {
    retain(sessionId: string, mediaType: string, data: string): RecordedImage {
      const bytes = Buffer.from(data, "base64");
      const hash = createHash("sha256").update(mediaType).update("\0").update(bytes).digest("hex");
      const reference = { type: "image" as const, hash, mediaType, size: bytes.length, sensitive: true };
      // A single oversized image must not evict the session's entire history.
      if (bytes.length > maxBytes) return reference;
      const dir = directory(sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, hash);
      if (existsSync(path) && existsSync(`${path}.json`)) return reference;
      const files = readdirSync(dir).filter((name) => /^[a-f0-9]{64}$/.test(name)).map((name) => {
        const metadataPath = join(dir, `${name}.json`);
        const order = existsSync(metadataPath) ? (JSON.parse(readFileSync(metadataPath, "utf8")) as { order: number }).order : 0;
        return { name, size: statSync(join(dir, name)).size, order };
      }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      let used = files.reduce((size, file) => size + file.size, 0);
      for (const file of files) {
        if (used + bytes.length <= maxBytes) break;
        rmSync(join(dir, file.name));
        rmSync(join(dir, `${file.name}.json`), { force: true });
        used -= file.size;
      }
      writeFileSync(path, bytes, { mode: 0o600 });
      writeFileSync(`${path}.json`, JSON.stringify({ mediaType, order: (files.at(-1)?.order ?? 0) + 1 }), { mode: 0o600 });
      return reference;
    },
    read(sessionId: string, hash: string): { mediaType: string; data: string } | null {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const path = join(directory(sessionId), hash);
      if (!existsSync(path) || !existsSync(`${path}.json`)) return null;
      const { mediaType } = JSON.parse(readFileSync(`${path}.json`, "utf8")) as { mediaType: string };
      return { mediaType, data: readFileSync(path).toString("base64") };
    },
    /** A fork owns the images in its copied visible history, independently of the source's lifecycle. */
    copyHistory(fromSessionId: string, toSessionId: string, history: unknown): void {
      const hashes = new Set<string>();
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(collect); return; }
        if (typeof value !== "object" || value === null) return;
        const block = value as Record<string, unknown>;
        if (block["type"] === "image" && typeof block["hash"] === "string") hashes.add(block["hash"]);
        else Object.values(block).forEach(collect);
      };
      collect(history);
      for (const hash of hashes) {
        const image = store.read(fromSessionId, hash);
        if (image !== null) store.retain(toSessionId, image.mediaType, image.data);
      }
    },
    purge(sessionId: string): void { rmSync(directory(sessionId), { recursive: true, force: true }); },
  };
  return store;
};
export type TranscriptImages = ReturnType<typeof createTranscriptImages>;
