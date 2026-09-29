import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { UNREACHABLE_OPENBAO, startFakeOpenBao, testCertificates, type FakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, keyManagerEvents, list, preview, update, verify } from "../../test/key-manager-connections.js";
import { refusal } from "../../test/sessions.js";

/**
 * The certificate preview (#366; key-managers spec, "Providers"; ADR 0028)
 * through the primary seam: `keyManagers.certificate.preview` against the
 * fake OpenBao, whose certificate a test CA issued, and what a person does
 * with the anchor it answers. That no request was sent is seen in the
 * fake's record of requests beside its count of connections.
 */

const { onCleanup } = useCleanups();

const withOpenBao = async () => {
  const t: TestEnvironment = await startTestEnvironment();
  onCleanup(() => t.close());
  const bao: FakeOpenBao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default"] });
  return { t, bao, client: await t.client() };
};

/** A PEM as the preview answers it: one certificate, as Node writes it. */
const pem = (text: string): string => new X509Certificate(text).toString();

describe("keyManagers.certificate.preview", () => {
  it("reads the certificate without sending a byte of a request, answering the leaf when it comes alone, with its fingerprint, subject, names and expiry, and changing nothing", async () => {
    const { t, bao, client } = await withOpenBao();
    const from = t.env.log.head();
    const leaf = new X509Certificate(testCertificates().certificate);

    const { certificate } = await preview(client, `${bao.address}/`);

    expect(certificate).toEqual({
      pem: pem(testCertificates().certificate),
      sha256Fingerprint: leaf.fingerprint256,
      subject: "CN=127.0.0.1",
      names: ["127.0.0.1", "localhost"],
      expiresAt: leaf.validToDate.toISOString(),
      selfSigned: false,
    });
    expect(bao.connections()).toBe(1);
    expect(bao.requests).toEqual([]);
    expect(await list(client)).toEqual([]);
    expect(await keyManagerEvents(client, from)).toEqual([]);
  });

  it("walks up to the issuer the chain carries: the CA, which signs itself", async () => {
    const { bao, client } = await withOpenBao();
    bao.present("chain");

    const { certificate } = await preview(client, bao.address);

    expect(certificate).toMatchObject({ pem: pem(bao.ca), subject: "CN=agent-harness ca", names: [], selfSigned: true, sha256Fingerprint: new X509Certificate(bao.ca).fingerprint256 });
    expect(bao.requests).toEqual([]);
  });

  it("becomes the connection's CA only when a person accepts it through add or update, and every request verifies against it after", async () => {
    const { bao, client } = await withOpenBao();
    const { certificate } = await preview(client, bao.address);

    // Unpinned, the test CA is no system CA: the connection is kept with its certificate rejected.
    const unpinned = await added(client, { address: bao.address, credential: approle() });
    expect(unpinned.status.kind).toBe("certificate-rejected");
    // The leaf a person accepted anchors the chain itself.
    const pinned = await update(client, { connectionId: unpinned.id, ca: certificate.pem });
    expect(pinned.result?.connection).toMatchObject({ ca: certificate.pem, status: { kind: "signed-in" } });

    // The key manager now presents a certificate another CA issued: the pinned one no longer verifies it.
    bao.present("other-ca");
    const [changed] = await verify(client, unpinned.id);
    expect(changed?.status).toMatchObject({ kind: "certificate-rejected", message: expect.stringContaining("does not verify against the pinned CA") });
    const other = await preview(client, bao.address);
    expect(other.certificate.sha256Fingerprint).not.toBe(certificate.sha256Fingerprint);
    expect((await list(client))[0]?.ca).toBe(certificate.pem);
  });

  it("answers unreachable naming the address for one nothing listens on, invalid_params for one that is not an https origin, and is refused below admin", async () => {
    const { t, client } = await withOpenBao();

    expect(await refusal(preview(client, UNREACHABLE_OPENBAO))).toMatchObject({ code: "unreachable", data: { address: UNREACHABLE_OPENBAO } });
    for (const address of ["http://127.0.0.1:8200", "bao.example.com", "https://user:pass@bao.example.com"]) {
      expect(await refusal(preview(client, address)), address).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["address"] })] } });
    }
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect(await refusal(preview(reader, UNREACHABLE_OPENBAO))).toMatchObject({ code: "forbidden" });
  });
});
