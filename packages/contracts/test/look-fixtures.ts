/**
 * Fixtures for an environment's name, icon and colour (workspace-picker
 * spec, "Name, icon and colour"; #323): a valid and an invalid instance of
 * each schema the export writes, and of the three commands' params and
 * results. `fixtures.ts` folds them into the package's fixture tables.
 */

interface Fixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";

export const validLook = { name: "LAB", icon: "server", colour: "teal" } as const;

const looks: Fixtures = {
  valid: [validLook, { name: "a-hostname-label-longer-than-forty-code-points-is-kept", icon: "laptop", colour: "pink" }],
  invalid: [{ ...validLook, name: "" }, { ...validLook, icon: "phone" }, { ...validLook, colour: "#008080" }, { name: "LAB", icon: "server" }],
};

export const lookSchemaFixtures: Record<string, Fixtures> = {
  "environment/icon.json": {
    valid: ["laptop", "desktop", "server", "nas", "cloud", "container", "board", "home", "office", "lab"],
    invalid: ["Laptop", "phone", "💻", "", null],
  },
  "environment/name.json": {
    valid: ["LAB", "x".repeat(40), ` ${"x".repeat(40)} `, "🖥".repeat(40), "SYSTEM \t SERVER"],
    invalid: ["", "   ", "x".repeat(41), "a\u0000b", "a\u200bb", "a\u2066b", 7],
  },
  "environment/look.json": looks,
  "environment/renamed.json": { valid: [{ name: "LAB" }], invalid: [{ name: "" }, { name: "x".repeat(41) }, {}] },
  "environment/icon-set.json": { valid: [{ icon: "nas" }], invalid: [{ icon: "phone" }, {}] },
  "environment/colour-set.json": { valid: [{ colour: "amber" }], invalid: [{ colour: "#ffbf00" }, { colour: "Amber" }, {}] },
};

export const lookMethodFixtures: Record<string, { params: Fixtures; result: Fixtures }> = {
  "environment.rename": {
    params: { valid: [{ commandId, name: "LAB" }, { commandId, name: "  SYSTEM  SERVER " }], invalid: [{ name: "LAB" }, { commandId, name: "" }, { commandId, name: "x".repeat(41) }] },
    result: looks,
  },
  "environment.setIcon": {
    params: { valid: [{ commandId, icon: "nas" }], invalid: [{ icon: "nas" }, { commandId, icon: "phone" }, { commandId }] },
    result: looks,
  },
  "environment.setColour": {
    params: { valid: [{ commandId, colour: "amber" }], invalid: [{ colour: "amber" }, { commandId, colour: "#ffbf00" }, { commandId }] },
    result: looks,
  },
};
