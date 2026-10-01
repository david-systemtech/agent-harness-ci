import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_NOTICE_TYPES,
  EnvironmentNotice,
  ForbiddenError,
  KNOWN_ENVIRONMENTS_MAX,
  KnownEnvironment,
  eventTypeEntry,
  registry,
} from "./index.js";

/**
 * The known-environments report (key-managers spec, "The orientation block"
 * and "Wire methods"; ADR 0011; #382): a desktop's or terminal UI's other
 * connections, each by id, name and address, reported whole to each
 * environment it connects to; the `environment.known-environments-updated`
 * notice the union's changes raise; and the refusal a program client
 * session gets.
 */

const published = (path: string) => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats.default(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", path), "utf8")) as object);
};

/** `value` through JSON and the zod schema, as a client reads it off the wire. */
const roundTrip = <T>(schema: { parse: (value: unknown) => T }, value: T): T => schema.parse(JSON.parse(JSON.stringify(value)));

const laptop = { id: "0192a5b0-7c1e-7d4a-9f00-000000000001", name: "laptop", address: "http://laptop.tail1234.ts.net:7433" } as const;
const nas = { id: "0192a5b0-7c1e-7d4a-9f00-000000000002", name: "Attic NAS", address: "https://[fd7a:115c::7]:7433" } as const;

describe("environment.knownEnvironments.report", () => {
  it("is a query at read that takes the client's other connections, each its id, name and address, and answers nothing, through the wire and the published schema", () => {
    const report = registry["environment.knownEnvironments.report"];
    expect([report.kind, report.scope]).toEqual(["query", "read"]);
    const params = { environments: [laptop, nas] };
    expect(roundTrip(report.params, params)).toEqual(params);
    expect(roundTrip(report.params, { environments: [] })).toEqual({ environments: [] });
    expect(roundTrip(report.result, {})).toEqual({});
    const validate = published("methods/environment.knownEnvironments.report/params.json");
    expect(validate(params), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ environments: [{ ...laptop, id: "laptop" }] })).toBe(false);
    expect(validate({ environments: [{ name: "laptop", address: laptop.address }] })).toBe(false);
    expect(published("methods/environment.knownEnvironments.report/result.json")({})).toBe(true);
  });

  it("takes a name of one line or white space collapsed later, never a control character, and at most the cap of environments", () => {
    const params = registry["environment.knownEnvironments.report"].params;
    expect(params.safeParse({ environments: [{ ...laptop, name: " two  words " }] }).success).toBe(true);
    for (const name of ["", "   ", "desk\u0000", "desk​", "x".repeat(201)]) {
      expect(params.safeParse({ environments: [{ ...laptop, name }] }).success, JSON.stringify(name)).toBe(false);
    }
    expect(params.safeParse({ environments: [{ ...laptop, name: "x".repeat(200) }] }).success).toBe(true);
    const many = Array.from({ length: KNOWN_ENVIRONMENTS_MAX + 1 }, () => laptop);
    expect(params.safeParse({ environments: many.slice(1) }).success).toBe(true);
    expect(params.safeParse({ environments: many }).success).toBe(false);
  });

  it("takes an address as a connection keeps it, an http or https origin, and nothing with white space, a path, a query, credentials or a control or format character in it", () => {
    for (const address of ["http://desk:7433", "https://desk.example.com:443", "http://100.64.0.7:7433", "http://[fd7a::1]:7433"]) {
      expect(KnownEnvironment.safeParse({ ...laptop, address }).success, address).toBe(true);
    }
    const invalid = ["desk:7433", "ftp://desk:21", "http://desk:7433/ws", "http://desk:7433?x=1", "http://user@desk:7433", "http://desk\n:7433", "http:// desk", ""];
    // A backslash is a path separator to a URL parser; control and format (zero-width, bidi) characters render unseen.
    invalid.push("http://desk:7433\\ws", "http://desk\u0000:7433", "http://de​sk:7433", "http://desk‮:7433", "http://desk\u007f:7433");
    for (const address of invalid) {
      expect(KnownEnvironment.safeParse({ ...laptop, address }).success, JSON.stringify(address)).toBe(false);
    }
  });

  it("is refused with forbidden and the reason program, the scope held", () => {
    const refusal = { code: "forbidden", message: "A program client session cannot report known environments.", data: { scope: "read", reason: "program" } } as const;
    expect(ForbiddenError.parse(refusal)).toEqual(refusal);
    expect(registry["environment.knownEnvironments.report"].error.parse(refusal)).toEqual(refusal);
    expect(published("errors/forbidden.json")(refusal)).toBe(true);
  });
});

describe("the environment.known-environments-updated notice", () => {
  it("is on the environment stream, never in the session list, carrying the union as the orientation block lists it, through the published schema", () => {
    expect(ENVIRONMENT_NOTICE_TYPES).toContain("environment.known-environments-updated");
    expect(eventTypeEntry("environment", "environment.known-environments-updated")).toMatchObject({ list: false });
    const type = "environment.known-environments-updated";
    const payload = { environments: [{ name: "Attic NAS", address: nas.address }, { name: "laptop", address: laptop.address }] };
    expect(roundTrip(EnvironmentNotice, { type, payload })).toEqual({ type, payload });
    expect(roundTrip(EnvironmentNotice, { type, payload: { environments: [] } })).toEqual({ type, payload: { environments: [] } });
    expect(EnvironmentNotice.safeParse({ type, payload: {} }).success).toBe(false);
    const validate = published("environment/known-environments-updated.json");
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ environments: [{ name: "laptop" }] })).toBe(false);
    expect(published("notices/environment-notice-type.json")(type)).toBe(true);
  });
});
