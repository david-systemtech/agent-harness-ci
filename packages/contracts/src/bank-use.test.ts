import { expect, it } from "vitest";
import { z } from "zod";
import { EVENT_TYPES, SessionBankUsedPayload, eventTypeEntry, exportedSchemas, methods } from "./index.js";

it("publishes successful folder use as an unlisted session event, alongside read/search tools and one drive scope for pins", () => {
  const value = { bankId: "6f1c2c1e-8a8f-4b5e-9a65-1d7c5b0f2a10", pointers: ["maya-memory:personal/homelab/"] };
  expect(SessionBankUsedPayload.parse(value)).toEqual(value);
  expect(SessionBankUsedPayload.safeParse({ ...value, pointers: [] }).success).toBe(false);
  expect(SessionBankUsedPayload.safeParse({ ...value, pointers: ["/etc/passwd"] }).success).toBe(false);
  expect(EVENT_TYPES.session["session.bank-used"].payload).toBe(SessionBankUsedPayload);
  expect(eventTypeEntry("session", "session.bank-used")?.list).toBe(false);
  expect(exportedSchemas().find((entry) => entry.path === "sessions/events/session.bank-used.json")?.schema).toBe(SessionBankUsedPayload);
  const search = exportedSchemas().find((entry) => entry.path === "banks/tools/search.json")!;
  const read = exportedSchemas().find((entry) => entry.path === "banks/tools/read.json")!;
  expect(z.toJSONSchema(search.schema).required).toEqual(["query"]);
  expect(Object.keys(z.toJSONSchema(search.schema).properties ?? {})).toEqual(["query", "bank", "scope", "limit"]);
  expect(Object.keys(z.toJSONSchema(read.schema).properties ?? {})).toEqual(["pointer"]);
  expect(methods.filter((method) => method.name === "banks.pin").map((method) => method.scope)).toEqual(["runs:drive"]);
});
