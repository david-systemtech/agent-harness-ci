import { URL } from "node:url";
import { cpSync, readFileSync, rmSync } from "node:fs";
const root = new URL("../", import.meta.url);
const web = new URL("packages/gui/dist/", root);
// Refuse an incomplete build before replacing the packaged directory.
readFileSync(new URL("index.html", web));
JSON.parse(readFileSync(new URL("version.json", web), "utf8"));
const destination = new URL("packages/environment/dist/serve/web-client/", root);
rmSync(destination, { recursive: true, force: true });
cpSync(web, destination, { recursive: true });
