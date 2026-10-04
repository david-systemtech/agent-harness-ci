export const pushMethodFixtures = {
  "attention.push.key": { params: { valid: [{}], invalid: [[]] }, result: { valid: [{ publicKey: "public-key-for-tests" }], invalid: [{}] } },
  "attention.push.test": { params: { valid: [{ id: "phone", sessionId: "session-1" }], invalid: [{ id: "phone" }] }, result: { valid: [{ status: "sent" }, { status: "retire" }], invalid: [{ status: "unknown" }] } },
};
