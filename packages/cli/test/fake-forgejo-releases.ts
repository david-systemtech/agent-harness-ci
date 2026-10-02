import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/**
 * A fake Forgejo for the release publisher's tests (#358): a loopback HTTP
 * server on port 0 answering the release routes of Forgejo's API as Forgejo
 * 16 does for a token that can write releases (read in its source,
 * `routers/api/v1/repo/release*.go`). A release by its tag answers 404 while
 * the tag has none, a draft included for such a token; creating a release
 * for a tag that has one is refused 409; deleting a release leaves its tag
 * and drops its assets; an asset uploads as the multipart field `attachment`
 * named by the `name` query. Any other token is refused 401. Nothing leaves
 * the loopback address.
 */

/** An asset the fake holds: its name, size and the SHA-256 of what was uploaded. */
export interface FakeAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** A release the fake holds. */
export interface FakeForgejoRelease {
  readonly id: number;
  readonly tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  readonly assets: FakeAsset[];
}

/** How the fake misbehaves, where a test asks. */
export interface FakeForgejoQuirks {
  /** An asset whose upload is answered 500 and kept nowhere. */
  readonly failUpload?: string;
  /** An asset whose upload is answered 201 and kept nowhere, as a proxy losing it would. */
  readonly loseUpload?: string;
  /** GitHub's API and raw upload protocol instead of Forgejo's multipart API. */
  readonly github?: boolean;
}

export interface FakeForgejo {
  /** The server's origin, `http://127.0.0.1:<port>`. */
  readonly server: string;
  /** Every request, `<METHOD> <path and query>`, the API's prefix left out. */
  readonly calls: string[];
  /** The bodies of the JSON requests, in order. */
  readonly bodies: unknown[];
  /** The releases it holds, by tag. */
  release(tag: string): FakeForgejoRelease | undefined;
  /** Adds a release for `tag`, as an earlier run or a person left it. */
  add(release: Omit<FakeForgejoRelease, "id">): FakeForgejoRelease;
  close(): Promise<void>;
}

export const startFakeForgejo = async (repository: string, token: string, quirks: FakeForgejoQuirks = {}): Promise<FakeForgejo> => {
  const PREFIX = quirks.github ? "/repos/" : "/api/v1/repos/";
  const releases: FakeForgejoRelease[] = [];
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let ids = 0;
  const add = (release: Omit<FakeForgejoRelease, "id">): FakeForgejoRelease => {
    const added = { ...release, id: (ids += 1) };
    releases.push(added);
    return added;
  };

  const send = (response: ServerResponse, status: number, body?: unknown): void => {
    response.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    bodies.push(body);
    return body;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, base: string): Promise<void> => {
    const url = new URL(request.url ?? "/", base);
    const method = request.method ?? "GET";
    calls.push(`${method} ${url.pathname.slice(PREFIX.length + repository.length)}${url.search}`);
    if (request.headers.authorization !== `${quirks.github ? "Bearer" : "token"} ${token}`) return send(response, 401, { message: "token is required" });
    const route = quirks.github ? url.pathname.replace(/^\/uploads/, "") : url.pathname;
    const path = route.startsWith(`${PREFIX}${repository}/`) ? route.slice(`${PREFIX}${repository}`.length) : null;
    const byTag = path?.match(/^\/releases\/tags\/([^/]+)$/);
    const byId = path?.match(/^\/releases\/(\d+)(\/assets)?$/);
    const release = byId ? releases.find((each) => each.id === Number(byId[1])) : undefined;
    const answer = (found: FakeForgejoRelease) => quirks.github ? { ...found, upload_url: `${base}/uploads/repos/${repository}/releases/${found.id}/assets{?name,label}` } : found;
    if (byTag && method === "GET") {
      const found = releases.find((each) => each.tag_name === decodeURIComponent(byTag[1] ?? ""));
      return found && !(quirks.github && found.draft) ? send(response, 200, answer(found)) : send(response, 404, { message: "Not Found" });
    }
    if (quirks.github && path === "/releases" && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const count = Number(url.searchParams.get("per_page") ?? "30");
      return send(response, 200, releases.slice((page - 1) * count, page * count).map(answer));
    }
    if (path === "/releases" && method === "POST") {
      const body = await readJson(request);
      if (releases.some((each) => each.tag_name === body["tag_name"])) return send(response, 409, { message: "Release has no Tag" });
      return send(response, 201, answer(add({ tag_name: String(body["tag_name"]), name: String(body["name"]), draft: body["draft"] === true, prerelease: body["prerelease"] === true, assets: [] })));
    }
    if (!byId || release === undefined) return send(response, 404, { message: "Not Found" });
    if (byId[2] !== undefined && method === "POST") {
      const name = url.searchParams.get("name") ?? "";
      let bytes: Buffer;
      if (quirks.github) {
        if (!url.pathname.startsWith("/uploads/") || request.headers["content-type"] !== "application/octet-stream") return send(response, 400);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        bytes = Buffer.concat(chunks);
      } else {
        const headers = { "content-type": request.headers["content-type"] ?? "" };
        const form = await new Request(url, { method, headers, body: Readable.toWeb(request) as ReadableStream, duplex: "half" } as RequestInit).formData();
        const file = form.get("attachment");
        if (!(file instanceof Blob)) return send(response, 400, { message: "attachment is missing" });
        bytes = Buffer.from(await file.arrayBuffer());
      }
      if (name === quirks.failUpload) return send(response, 500, { message: "upload failed" });
      const asset = { id: (ids += 1), name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      if (name !== quirks.loseUpload) release.assets.push(asset);
      return send(response, 201, asset);
    }
    if (method === "GET") return send(response, 200, answer(release));
    if (method === "PATCH") {
      const body = await readJson(request);
      if (typeof body["draft"] === "boolean") release.draft = body["draft"];
      if (typeof body["prerelease"] === "boolean") release.prerelease = body["prerelease"];
      return send(response, 200, answer(release));
    }
    if (method === "DELETE") {
      releases.splice(releases.indexOf(release), 1);
      return send(response, 204);
    }
    return send(response, 405, { message: "Method Not Allowed" });
  };

  const server = createServer((request, response) => {
    handle(request, response, `http://127.0.0.1:${(server.address() as AddressInfo).port}`).catch((error: unknown) => send(response, 500, { message: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    calls,
    bodies,
    release: (tag) => releases.find((each) => each.tag_name === tag),
    add,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
