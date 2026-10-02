const pointer = "maya-memory:personal/homelab/";
const topics = { backup: { line: "Backup facts", memories: ["backup-schedule"] } };
const proposal = { pointer, count: 1, clusters: [{ prefix: "backup", memories: ["backup-schedule"] }] };
const landing = { state: "awaiting-review", bank: "maya-memory", pullRequest: "https://git.example.test/maya/memory/pulls/1", files: [{ path: "projects/personal/homelab/PROJECT.md", state: "pending" }] };
const commandId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
export const bankSplitSchemaFixtures = {
  "banks/split-pointer.json": { valid: [pointer, "maya-memory:personal/homelab/nas/"], invalid: ["maya-memory:personal/", "maya-memory:personal/homelab/memories/backup/", "maya-memory:../homelab/", "maya-memory:backup-schedule"] },
  "banks/split-topics.json": { valid: [topics], invalid: [{ "../backup": topics.backup }, { backup: { line: "Backup", memories: [] } }, { backup: { line: "", memories: ["backup-schedule"] } }] },
  "banks/split-proposal.json": { valid: [proposal, { pointer, count: 0, clusters: [] }], invalid: [{ ...proposal, count: -1 }, { ...proposal, clusters: [{ prefix: "backup", memories: [] }] }] },
};
export const bankSplitMethodFixtures = {
  "banks.split.propose": { params: { valid: [{ pointer }], invalid: [{}, { pointer: "maya-memory:personal/" }] }, result: { valid: [proposal], invalid: [{}, { ...proposal, count: -1 }] } },
  "banks.split.apply": { params: { valid: [{ commandId, pointer, topics }], invalid: [{ pointer, topics }, { commandId, pointer, topics: { backup: { memories: [] } } }] }, result: { valid: [{ landing }], invalid: [{}, { landing: { state: "landed", bank: "maya-memory" } }] } },
};
