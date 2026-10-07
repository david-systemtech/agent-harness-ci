import { renderUnicodeCompact } from "uqr";
import { expect, it } from "vitest";
import { startTestEnvironment } from "../../environment/test/helper.js";
import { runCli } from "./cli.js";
import { parseClientAddressHeader, parseWebOrigin, UsageError } from "./args.js";

it("prints the canonical Phone link and QR with its exact limited grant", async () => {
  const environment = await startTestEnvironment({ webOrigin: "https://web.example:8443" });
  try {
    let out = "";
    let error = "";
    expect(await runCli(["pair", "--preset", "phone", "--data-dir", environment.dataDir], { stdout: text => { out += text; }, stderr: text => { error += text; } })).toBe(0);
    expect(error).toBe("");
    const link = out.split("\n").find(line => line.trim().startsWith("https://"))?.trim();
    expect(link).toMatch(/^https:\/\/web.example:8443\/pair#[A-Z2-9]+$/);
    expect(out).toContain(renderUnicodeCompact(link!, { border: 2 }));
    expect(out).toContain("Preset: Phone\n  Scopes: read, sessions:write, runs:drive\n  Ceiling: acceptEdits");
  } finally { await environment.close(); }
});
it("accepts an explicit canonical HTTPS origin and refuses paths, credentials and HTTP", () => {
  expect(parseWebOrigin("https://web.example:8443")).toBe("https://web.example:8443");
  expect(parseWebOrigin(undefined)).toBeUndefined();
  for (const value of ["http://web.example", "https://web.example/", "https://web.example?x=1", "https://user:password@web.example"]) expect(() => parseWebOrigin(value)).toThrow(UsageError);
});
it("explains the canonical spelling required for an HTTPS origin", () => {
  for (const value of ["https://WEB.example", "https://web.example:443"]) {
    expect(() => parseWebOrigin(value)).toThrow("canonical HTTPS origin");
  }
});
it("takes a header name for the client address behind the web origin's proxy, and refuses anything else", () => {
  expect(parseClientAddressHeader(undefined)).toBeUndefined();
  expect(parseClientAddressHeader("X-Real-IP")).toBe("X-Real-IP");
  for (const value of ["", "X Real IP", "x-real-ip:", "x-real-ip\r\n"]) expect(() => parseClientAddressHeader(value)).toThrow("--client-address-header takes a header name");
});
