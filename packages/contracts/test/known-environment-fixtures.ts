/**
 * Fixtures for the known-environments report (key-managers spec, "The
 * orientation block"; #382): a valid and an invalid instance of each schema
 * the export writes, and of the report's params and result. `fixtures.ts`
 * folds them into the package's fixture tables.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const laptop = { id: "0192a5b0-7c1e-7d4a-9f00-000000000001", name: "laptop", address: "http://laptop.tail1234.ts.net:7433" } as const;
const listed = { name: "laptop", address: "http://laptop.tail1234.ts.net:7433" } as const;

/** A known-environments notice as the environment stream carries it: valid, and one missing an address. */
export const knownEnvironmentsNotice = {
  valid: { type: "environment.known-environments-updated", payload: { environments: [{ name: "Attic NAS", address: "https://[fd7a:115c::7]:7433" }, listed] } },
  invalid: { type: "environment.known-environments-updated", payload: { environments: [{ name: "laptop" }] } },
} as const;

export const knownEnvironmentSchemaFixtures: Record<string, Fixtures> = {
  "environment/known-environment.json": {
    valid: [laptop, { ...laptop, name: " two  words ", address: "https://[fd7a::1]:7433" }],
    invalid: [{ ...laptop, id: "laptop" }, { ...laptop, name: "" }, { ...laptop, name: "a\u0000b" }, { ...laptop, address: "http://laptop:7433/ws" }, listed],
  },
  "environment/listed-environment.json": { valid: [listed], invalid: [{ name: "laptop" }, { ...listed, address: "laptop:7433" }] },
  "environment/known-environments-updated.json": {
    valid: [knownEnvironmentsNotice.valid.payload, { environments: [] }],
    invalid: [knownEnvironmentsNotice.invalid.payload, {}],
  },
};

export const knownEnvironmentMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "environment.knownEnvironments.report": {
    params: { valid: [{ environments: [] }, { environments: [laptop] }], invalid: [{}, { environments: [listed] }, { environments: laptop }] },
    result: { valid: [{}], invalid: [[], "ok", null] },
  },
};
