/**
 * Fixtures for what an environment binds (env spec, "Binding and
 * discovery"; #574): a valid and an invalid instance of the bind address,
 * the binding `environment.status` answers and the two binding keys.
 * `fixtures.ts` folds them into the package's fixture table.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

/** Addresses an environment may bind, and what is none: the wildcard in each spelling, a name, a zone, an empty string. */
const addresses: Fixtures = {
  valid: ["192.168.1.20", "10.0.0.7", "100.101.102.103", "fd00::20", "2001:db8::1", "::1"],
  invalid: ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::0", "0::", "::ffff:0:0", "desk.local", "fe80::1%eth0", "192.168.1.256", "", null],
};

/**
 * What an environment binds and could bind: the tailnet and a LAN address, the tailnet alone, nothing but loopback, nothing but
 * loopback with a Tailscale address found since the start (#861), and an environment that predates `tailnetFound`.
 */
export const validBindings = [
  { tailnet: { address: "100.101.102.103", name: "desk.tail1234.ts.net" }, tailnetFound: null, lan: "192.168.1.20", lanAddresses: ["192.168.1.20", "fd00::20"] },
  { tailnet: { address: "100.101.102.103", name: null }, tailnetFound: null, lan: null, lanAddresses: [] },
  { tailnet: null, tailnetFound: null, lan: null, lanAddresses: ["192.168.1.20"] },
  { tailnet: null, tailnetFound: "100.64.0.9", lan: null, lanAddresses: [] },
  { tailnet: null, lan: null, lanAddresses: ["192.168.1.20"] },
];

export const invalidBindings = [
  {},
  { tailnet: null, lan: null },
  { tailnet: { address: "100.101.102.103" }, lan: null, lanAddresses: [] },
  { tailnet: { address: "100.101.102.103", name: "" }, lan: null, lanAddresses: [] },
  { tailnet: null, lan: "0.0.0.0", lanAddresses: [] },
  { tailnet: null, lan: null, lanAddresses: ["::"] },
  { tailnet: null, lan: false, lanAddresses: [] },
  { tailnet: null, tailnetFound: "0.0.0.0", lan: null, lanAddresses: [] },
  { tailnet: null, tailnetFound: "desk.tail1234.ts.net", lan: null, lanAddresses: [] },
  { tailnet: null, tailnetFound: false, lan: null, lanAddresses: [] },
];

export const networkSchemaFixtures: Record<string, Fixtures> = {
  "network/bind-address.json": addresses,
  "network/environment-binding.json": { valid: validBindings, invalid: invalidBindings },
  "settings/keys/network.bindTailnet.json": { valid: [true, false], invalid: [null, "on", 1] },
  "settings/keys/network.bindLan.json": { valid: [null, "192.168.1.20", "fd00::20"], invalid: ["0.0.0.0", "::", false, true, "desk.local", ""] },
};
