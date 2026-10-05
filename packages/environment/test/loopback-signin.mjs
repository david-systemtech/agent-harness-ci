import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

// A scripted provider CLI: it alone owns the callback and the proof key.
if (process.argv.includes("--help")) {
  console.log("Usage: scripted auth login");
  process.exit(0);
}
const state = "state-for-tests";
const verifier = "proof-key-for-tests";
const challenge = createHash("sha256").update(verifier).digest("base64url");
let consumed = false;
const finish = async (code, returnedState, response) => {
  if (returnedState !== state || consumed) {
    response?.writeHead(400).end("Invalid state or second use");
    return;
  }
  consumed = true;
  const exchanged = await globalThis.fetch(process.env["SCRIPTED_TOKEN_URL"], {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state, code_verifier: verifier }),
  });
  response?.writeHead(exchanged.ok ? 200 : 400).end("You can close this page.");
  server.close(() => process.exit(exchanged.ok ? 0 : 1));
};
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
  void finish(url.searchParams.get("code"), url.searchParams.get("state"), response);
});
server.listen(0, "127.0.0.1", () => {
  const url = new URL("https://provider.example.test/oauth/authorize");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", `http://127.0.0.1:${server.address().port}/callback`);
  console.log(`If the browser didn't open, visit: ${url}`);
});
createInterface({ input: process.stdin }).on("line", line => {
  const [code, returnedState] = line.trim().split("#");
  void finish(code, returnedState);
});
