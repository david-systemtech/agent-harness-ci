import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

/**
 * A loopback web server for `web_read`'s tests (browser spec, "Testing
 * Decisions": `web_read` against a loopback HTTP server): bound to
 * 127.0.0.1 on port 0, serving each path as a test scripts it, recording
 * every request it was sent, and able to hold a request unanswered until the
 * test lets it go. No test reaches the real network.
 */

/** What a path answers: a status (preset 200), headers, and a body. */
export interface WebAnswer {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

/** A path's answer, or a function of the request that gives one; `held` leaves the request unanswered. */
export type WebRoute = WebAnswer | "held" | ((request: IncomingMessage) => WebAnswer);

/** A request as the server received it: its path, its headers, and the address it was sent to. */
export interface ReceivedRequest {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
}

export interface WebServer {
  /** The server's origin: `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly port: number;
  /** An address on the server. */
  url(path: string): string;
  /** Adds or replaces a path's route. */
  route(path: string, route: WebRoute): void;
  /** Every request, in order. */
  readonly requests: readonly ReceivedRequest[];
  /** Resolves once a request for `path` has arrived. */
  requested(path: string): Promise<void>;
  /** Answers every held request with a 200 and `body`. */
  release(body?: string): void;
  close(): Promise<void>;
}

/** An HTML page of `body`, titled `title`. */
export const htmlPage = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** An HTML answer. */
export const html = (body: string, status = 200): WebAnswer => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body });

/** A redirect to `location`. */
export const redirect = (location: string, status = 302): WebAnswer => ({ status, headers: { location } });

export const serveWeb = async (routes: Readonly<Record<string, WebRoute>> = {}): Promise<WebServer> => {
  const table = new Map<string, WebRoute>(Object.entries(routes));
  const requests: ReceivedRequest[] = [];
  const waiters: { readonly path: string; readonly resolve: () => void }[] = [];
  const held: ServerResponse[] = [];
  const answer = (response: ServerResponse, { status = 200, headers = {}, body = "" }: WebAnswer) => {
    response.writeHead(status, headers);
    response.end(body);
  };
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ path, headers: request.headers });
    for (const waiter of waiters.filter((candidate) => candidate.path === path)) waiter.resolve();
    const route = table.get(path);
    if (route === undefined) answer(response, { status: 404, headers: { "content-type": "text/plain" }, body: "Not found" });
    else if (route === "held") held.push(response);
    else answer(response, typeof route === "function" ? route(request) : route);
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    url: (path) => `${origin}${path}`,
    route: (path, route) => void table.set(path, route),
    requests,
    requested: (path) =>
      requests.some((request) => request.path === path)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ path, resolve });
          }),
    release(body = "") {
      for (const response of held.splice(0)) answer(response, { headers: { "content-type": "text/plain" }, body });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

/**
 * A dialer that connects every address to `server` and records the address
 * it was handed, so a test can serve a name that resolves to a public
 * address from loopback and see which address the connection went to.
 */
export const dialingTo = (server: Pick<WebServer, "port">) => {
  const dialled: string[] = [];
  return {
    dialled,
    dial: (target: { readonly address: string; readonly port: number }): Socket => {
      dialled.push(`${target.address}:${target.port}`);
      return connect({ host: "127.0.0.1", port: server.port });
    },
  };
};

/**
 * A PDF of `pages`, each page one line of text, written out by hand with its
 * cross-reference table: small enough to build in a test, real enough for
 * pdf.js to read. `padding` bytes of a stream no page uses follow the pages,
 * to make one as large as a test needs.
 */
export const pdfOf = (pages: readonly string[], padding = 0): Uint8Array => {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  const catalog = add("");
  const tree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = pages.map((text) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, (character) => `\\${character}`)}) Tj ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  if (padding > 0) add(`<< /Length ${padding} >>\nstream\n${" ".repeat(padding)}\nendstream`);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const offset = Buffer.byteLength(out, "latin1");
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
};

/**
 * The resolver a test environment's `web_read` uses unless a test gives its
 * own: it resolves no name, so no test asks the real DNS.
 */
export const noResolver = async (host: string): Promise<never> => {
  throw Object.assign(new Error(`A test environment resolves no name (${host}).`), { code: "ENOTFOUND" });
};

/**
 * The dialer a test environment's `web_read` uses unless a test gives its
 * own: a loopback address is dialled as it is, and any other goes to a
 * loopback port nothing listens on, refused at once, so no test reaches the
 * real network.
 */
export const loopbackDialer = (target: { readonly address: string; readonly port: number }): Socket =>
  /^(?:127\.|::1$|::ffff:127\.)/.test(target.address) ? connect({ host: target.address, port: target.port }) : connect({ host: "127.0.0.1", port: 1 });
