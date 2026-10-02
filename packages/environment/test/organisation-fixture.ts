import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderSessionInfo } from "../src/adapter/contract.js";
import { createClaudeAdapter } from "../src/adapters/claude/index.js";
import { NO_SETUP_STEPS } from "./setup-steps.js";
import { machinePointedAt } from "../src/state-import/source/folders.js";

export const organisationFixture = (tempDir: () => string) => {
  const source = tempDir();
  const terminal = tempDir();
  const directory = tempDir();
  const workspace = tempDir();
  writeFileSync(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "fixture@example.com" } }));
  writeFileSync(join(source, "profiles.json"), JSON.stringify({ version: 2, profiles: [{ id: "work", label: "Work", providerId: "claude", configDir: directory }] }));
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const listing: ProviderSessionInfo[] = ids.map((providerSessionId, i) => ({ providerSessionId, customTitle: null, summary: `Session ${i}`, firstPrompt: "Hello", workingDirectory: workspace, tag: i === 0 ? "archived" : null, createdAt: null, lastModified: "2026-10-01T00:00:00.000Z" }));
  const base = createClaudeAdapter({ hostEnv: { HOME: tempDir() }, runCommand: async () => { throw new Error("No provider process during import."); } });
  const adapter = { ...base, listSessions: async () => listing };
  const options = { accounts: [], otherAdapters: [adapter], setupSteps: NO_SETUP_STEPS, stateImportSource: machinePointedAt({ dataFolder: source, terminalFolder: terminal, home: tempDir() }) };
  return { source, terminal, directory, ids, listing, options };
};
