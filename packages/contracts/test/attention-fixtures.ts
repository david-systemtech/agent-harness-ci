const target = { id: "target-1", transport: "push", enabled: true, completion: false, configuration: {} };
const configuration = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field-${index}`, "value-for-tests"]));
const atLimit = { ...target, configuration };
const overLimit = { ...target, configuration: { ...configuration, extra: "value-for-tests" } };
const status = { id: "target-1", transport: "push", enabled: true, completion: false, global: false, state: "ready", failure: null };
const commandId = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const attentionSchemaFixtures = {
  "attention/payload.json": { valid: [{ message: "A session needs you", url: "https://example.test:8443/#/session/env-1/session-1" }], invalid: [{ message: "Prompt text", url: "https://example.test/" }, { message: "A session needs you", url: "http://example.test/#/session/env-1/session-1" }] },
  "attention/target-input.json": { valid: [target, atLimit], invalid: [{ ...target, transport: "email" }, { ...target, completion: undefined }, overLimit] },
  "attention/target-status.json": { valid: [status, { ...status, transport: "webhook", webhookEndpoint: "phone-attention", global: true }], invalid: [{ ...status, state: "unknown" }, { ...status, transport: "webhook", webhookEndpoint: "https://receiver.example/attention" }] },
};
export const attentionMethodFixtures = {
  "attention.targets.list": { params: { valid: [{}], invalid: [[]] }, result: { valid: [{ targets: [status] }, { targets: [] }], invalid: [{ targets: [{}] }] } },
  ...Object.fromEntries(["attention.targets.set", "attention.routes.set"].map(name => [name, { params: { valid: [{ commandId, target }, { commandId, target: atLimit }], invalid: [{ commandId, target: {} }, { commandId, target: overLimit }] }, result: { valid: [{ id: "target-1" }], invalid: [{}] } }])),
  ...Object.fromEntries(["attention.targets.configure", "attention.routes.configure"].map(name => [name, { params: { valid: [{ commandId, id: "target-1", enabled: false, completion: false }], invalid: [{ commandId, id: "target-1" }] }, result: { valid: [{ id: "target-1" }], invalid: [{}] } }])),
  ...Object.fromEntries(["attention.targets.remove", "attention.routes.remove"].map(name => [name, { params: { valid: [{ commandId, id: "target-1" }], invalid: [{ commandId, id: "" }] }, result: { valid: [{ id: "target-1" }], invalid: [{}] } }])),
};
