import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { nativeOAuthListener } from "../../../scripts/check-packaged-provider-sign-in.mjs";

// Script the exchange and CLI orchestration; callback handling is the installed native client's code.
if (process.argv.includes("--help")) {
  console.log("Usage: scripted auth login");
  process.exit(0);
}
const state = "state-for-tests";
const verifier = "proof-key-for-tests";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const listener = nativeOAuthListener(process.env["SCRIPTED_NATIVE_CLI"]);
const finish = async code => {
  const exchanged = await globalThis.fetch(process.env["SCRIPTED_TOKEN_URL"], {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state, code_verifier: verifier }),
  });
  if (listener.hasPendingResponse()) listener.handleSuccessRedirect([], response => {
    response.writeHead(exchanged.ok ? 200 : 400).end("You can close this page.");
  });
  listener.close();
  listener.localServer.close(() => process.exit(exchanged.ok ? 0 : 1));
};
const port = await listener.start();
void listener.waitForAuthorization(state, () => {
  const url = new URL("https://provider.example.test/oauth/authorize");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/callback`);
  console.log(`If the browser didn't open, visit: ${url}`);
}).then(finish, () => { listener.close(); process.exit(1); });
createInterface({ input: process.stdin }).on("line", line => {
  const [code, returnedState] = line.trim().split("#");
  if (returnedState !== state) { listener.close(); process.exit(1); }
  listener.close();
  void finish(code);
});
