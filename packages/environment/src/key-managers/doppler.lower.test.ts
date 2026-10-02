import { expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { DOPPLER_TEST_TOKEN, startFakeDoppler } from "../../test/fake-doppler.js";
import { createDopplerProvider } from "./doppler.js";
import type { SignInTarget } from "./provider.js";
const { onCleanup } = useCleanups();

it("proves a service token with its identity and names only, preserving the token", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  api.secrets.set("FORGE_HOME_TOKEN", "forge-token-for-tests");
  const provider = createDopplerProvider();
  const target: SignInTarget = { address: api.address, ca: null, method: "token", mount: "token", username: null };
  expect(await provider.logIn(target, { method: "token", token: DOPPLER_TEST_TOKEN })).toEqual({ outcome: "logged-in", token: DOPPLER_TEST_TOKEN, minted: false });
  expect(await provider.lookUp(target, DOPPLER_TEST_TOKEN)).toMatchObject({ outcome: "found", information: { displayName: "Harness (service_token)", renewable: false, policies: [] }, root: false });
  expect(api.requests.map(({ path }) => path)).toEqual(["/v3/me", "/v3/configs/config/secrets/names"]);
  expect(api.requests[1]?.query).not.toHaveProperty("project");
  expect(api.requests[1]?.query).not.toHaveProperty("config");
});

it("maps authentication, permission, missing-secret, rate-limit and network failures without echoing credentials", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const target: SignInTarget = { address: api.address, ca: null, method: "token", mount: "token", username: null };
  const provider = createDopplerProvider();
  const reference = { provider: "doppler", connectionId: "connection-for-tests", name: "FORGE_HOME_TOKEN" } as const;
  for (const [status, outcome] of [[401, "credential-rejected"], [403, "credential-rejected"], [429, "rate-limited"], [503, "unreachable"], [400, "credential-rejected"]] as const) {
    api.status(status);
    expect(await provider.verify(target, DOPPLER_TEST_TOKEN, { tokenRole: null })).toMatchObject({ outcome });
  }
  api.status(403);
  expect(await provider.read(target, DOPPLER_TEST_TOKEN, reference)).toMatchObject({ outcome: "denied" });
  api.status(404);
  expect(await provider.read(target, DOPPLER_TEST_TOKEN, reference)).toMatchObject({ outcome: "not-found" });
  api.status(200);
  expect(await provider.read(target, DOPPLER_TEST_TOKEN, reference)).toMatchObject({ outcome: "not-found" });
  const offline = createDopplerProvider(async () => { throw new Error(DOPPLER_TEST_TOKEN); });
  const answer = await offline.verify(target, DOPPLER_TEST_TOKEN, { tokenRole: null });
  expect(answer).toMatchObject({ outcome: "unreachable" });
  expect(JSON.stringify(answer)).not.toContain(DOPPLER_TEST_TOKEN);
});

it("reads only the named computed value, sends optional scope only when named, and preserves different values unless overwrite is requested", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const target: SignInTarget = { address: api.address, ca: null, method: "token", mount: "token", username: null };
  const provider = createDopplerProvider();
  api.secrets.set("FORGE_HOME_TOKEN", "first-value-for-tests");
  const reference = { provider: "doppler", connectionId: "connection-for-tests", name: "FORGE_HOME_TOKEN", project: "project-for-tests", config: "harness" } as const;
  expect(await provider.read(target, DOPPLER_TEST_TOKEN, reference)).toEqual({ outcome: "read", value: "first-value-for-tests" });
  expect(api.requests[0]?.query).toEqual({ project: "project-for-tests", config: "harness", secrets: "FORGE_HOME_TOKEN", include_dynamic_secrets: "false" });
  const write = { reference, value: "second-value-for-tests", overwrite: false, fields: {} };
  expect(await provider.write(target, DOPPLER_TEST_TOKEN, write)).toEqual({ outcome: "exists" });
  expect(api.secrets.get(reference.name)).toBe("first-value-for-tests");
  expect(await provider.write(target, DOPPLER_TEST_TOKEN, { ...write, overwrite: true })).toEqual({ outcome: "written" });
  expect(await provider.read(target, DOPPLER_TEST_TOKEN, reference)).toEqual({ outcome: "read", value: "second-value-for-tests" });
  expect(await provider.list(target, DOPPLER_TEST_TOKEN, { mount: null, path: null })).toEqual({ outcome: "listed", names: ["FORGE_HOME_TOKEN"] });
  expect(api.requests.at(-1)?.query).toEqual({ include_dynamic_secrets: "false" });
});

it("checks write access without changing values and accepts the documented secrets response without a success flag", async () => {
  const api = await startFakeDoppler();
  onCleanup(api.close);
  const target: SignInTarget = { address: api.address, ca: null, method: "token", mount: "token", username: null };
  const provider = createDopplerProvider();
  api.secrets.set("EXISTING", "existing-value-for-tests");
  const location = { mount: "project-for-tests", path: "harness" };
  expect(await provider.canWrite(target, DOPPLER_TEST_TOKEN, location)).toEqual({ outcome: "checked", writable: true });
  expect([...api.secrets]).toEqual([["EXISTING", "existing-value-for-tests"]]);
  expect(api.requests).toEqual([{ method: "POST", path: "/v3/configs/config/secrets", query: { project: "project-for-tests", config: "harness" }, body: { secrets: {} } }]);
  api.writable(false);
  expect(await provider.canWrite(target, DOPPLER_TEST_TOKEN, location)).toEqual({ outcome: "checked", writable: false });
  expect([...api.secrets]).toEqual([["EXISTING", "existing-value-for-tests"]]);
});

it("does not call a write successful when Doppler answers success false", async () => {
  const provider = createDopplerProvider(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
  const target: SignInTarget = { address: "http://doppler.example.test", ca: null, method: "token", mount: "token", username: null };
  expect(await provider.canWrite(target, DOPPLER_TEST_TOKEN, { mount: "", path: "harness" })).toMatchObject({ outcome: "unreachable" });
});

it("verifies TLS even when the host disables certificate verification", async () => {
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  onCleanup(() => { vi.unstubAllEnvs(); });
  const api = await startFakeDoppler({ tls: true });
  onCleanup(api.close);
  const target: SignInTarget = { address: api.address, ca: null, method: "token", mount: "token", username: null };
  expect(await createDopplerProvider().verify(target, DOPPLER_TEST_TOKEN, { tokenRole: null })).toMatchObject({ outcome: "certificate-rejected" });
  expect(api.requests).toEqual([]);
});

it("rejects a malformed write-permission answer", async () => {
  const provider = createDopplerProvider(async () => new Response("{}", { status: 200 }));
  const target: SignInTarget = { address: "http://doppler.example.test", ca: null, method: "token", mount: "token", username: null };
  expect(await provider.canWrite(target, DOPPLER_TEST_TOKEN, { mount: "", path: "harness" })).toMatchObject({ outcome: "unreachable" });
});
