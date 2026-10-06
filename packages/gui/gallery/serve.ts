import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";

/**
 * The one origin the capture serves the built gallery at. A free port changed on every hosted run, and a scene that
 * shows the page's own origin (the refused further origin's pairing line) differed from its baseline in those digits
 * alone (#1763). The port sits below Linux's ephemeral range, so no outgoing connection on the runner holds it.
 */
export const galleryOrigin = "http://127.0.0.1:5180";

const types: Readonly<Record<string, string>> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

/** Serves `directory`'s files at the gallery origin; fails rather than moving to another port when that one is taken. */
export const serveGallery = async (directory: string): Promise<Server> => {
  const server = createServer((request, response) => {
    const path = resolve(directory, `.${new URL(request.url ?? "/", "http://localhost").pathname}`);
    if (!path.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
    response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
    const file = createReadStream(path);
    file.on("error", () => response.writeHead(404).end());
    file.pipe(response);
  });
  const { hostname, port } = new URL(galleryOrigin);
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(Number(port), hostname, done); });
  return server;
};
