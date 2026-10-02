import { expect, it, vi } from "vitest";
import { bitwardenUrls } from "./bitwarden-sdk.js";
import { createBitwardenProvider } from "./bitwarden.js";
import { BITWARDEN_TEST_TOKEN, scriptedBitwarden } from "../../test/fake-bitwarden.js";
vi.mock("@bitwarden/sdk-napi", () => ({ BitwardenClient: class {} }));
const target = { address: "https://vault.bitwarden.com", ca: null, method: "token", mount: "", username: null } as const;

it("uses separate US/EU API and identity hosts and the self-hosted server's paths", () => {
  expect(bitwardenUrls(target.address)).toEqual({ apiUrl: "https://api.bitwarden.com", identityUrl: "https://identity.bitwarden.com" });
  expect(bitwardenUrls("https://vault.bitwarden.eu")).toEqual({ apiUrl: "https://api.bitwarden.eu", identityUrl: "https://identity.bitwarden.eu" });
  expect(bitwardenUrls("https://bitwarden.test:8443")).toEqual({ apiUrl: "https://bitwarden.test:8443/api", identityUrl: "https://bitwarden.test:8443/identity" });
});

it("reports the published Node SDK's missing organization discovery with a reason without contacting a service", async () => {
  const provider = createBitwardenProvider();
  expect(await provider.logIn(target, { method: "token", token: BITWARDEN_TEST_TOKEN })).toMatchObject({ outcome: "provider-unavailable", message: expect.stringContaining("organization id") });
});

it("refuses an aborted SDK operation before loading or using a credential", async () => {
  const sdk = scriptedBitwarden();
  const provider = createBitwardenProvider(sdk.load);
  const signal = AbortSignal.abort();
  expect(await provider.logIn(target, { method: "token", token: BITWARDEN_TEST_TOKEN }, signal)).toMatchObject({ outcome: "unreachable" });
  expect(sdk.calls).toEqual([]);
});
