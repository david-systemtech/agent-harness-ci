const commandId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const bankId = "b2f6a1c9-7e04-4b5a-8c32-3d7f5e1a9b00";
export const bankValidatorUpdateMethodFixtures = {
  "banks.validator.update": {
    params: { valid: [{ commandId, bankId }], invalid: [{ bankId }, { commandId }, { commandId, bankId: "invalid" }] },
    result: {
      valid: [{ version: 1, landing: null }, { version: 1, landing: { state: "awaiting-review", bank: "maya-memory", pullRequest: "https://forge.example.test/maya/memory/pulls/1", files: [{ path: ".agent-harness/validate.mjs", state: "pending" }] } }],
      invalid: [{ version: 0, landing: null }, { version: 1 }, { version: 1, landing: {} }],
    },
  },
};

export const bankValidatorUpdateSchemaFixtures = {
  "banks/validator-status.json": {
    valid: [{ installedVersion: 1, currentVersion: 2, needsUpdate: true }, { installedVersion: null, currentVersion: 1, needsUpdate: true }],
    invalid: [{ installedVersion: -1, currentVersion: 1, needsUpdate: true }, { installedVersion: 1, currentVersion: 0, needsUpdate: false }, { installedVersion: 1, currentVersion: 1 }],
  },
};
