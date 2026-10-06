import { randomUUID } from "node:crypto";
import { PRODUCT_NAME, type CarryOverInventory, type StateImportAccountInventories, type StateImportReport } from "@agent-harness/contracts";
import { defaultDataDirectory } from "@agent-harness/environment";
import { parseOptions, parsePort } from "./args.js";
import { LocalFailure, LocalRefusal, withLocalSession, type LocalCall, type Net } from "./local-session.js";

export const STATE_IMPORT_USAGE = `${PRODUCT_NAME} state-import [--dry-run] [--json] [--data-dir <path>] [--port <n>]`;

interface StateImportContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly net: Net;
}

export const stateImport = async (args: readonly string[], context: StateImportContext): Promise<number> => {
  const values = parseOptions(args, { "dry-run": { type: "boolean" }, json: { type: "boolean" }, "data-dir": { type: "string" }, port: { type: "string" } });
  const target = { dataDir: values["data-dir"] ?? defaultDataDirectory(), port: parsePort(values.port, 1) };
  try {
    const { answer, inventory } = await withLocalSession(target, context.net, `${PRODUCT_NAME} state-import`, async (call) => {
      const inventory = values.json ? null : await accountInventories(call);
      // A new request replans on the Environment; receipts never save report results.
      const answer = await call("stateImport.run", { commandId: randomUUID(), dryRun: values["dry-run"] ?? false }, { timeoutMs: IMPORT_WAIT_MS });
      return { answer, inventory };
    });
    if (answer.receipt.status === "rejected") {
      const { message, data } = answer.receipt.error;
      const reason = typeof data["reason"] === "string" ? ` (${data["reason"]})` : "";
      throw new LocalFailure(`The environment refused state import${reason}: ${message}`);
    }
    if (answer.result === undefined) throw new LocalFailure("The environment answered state import with a receipt only; run state-import again for a fresh report.");
    context.stdout(values.json ? `${JSON.stringify(answer.result, null, 2)}\n` : renderReport(answer.result, inventory));
    return answer.result.failed.length === 0 && (inventory === null || (inventory.failed.length === 0 && inventory.accounts.every((entry) => entry.failure === null))) ? 0 : 1;
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    context.stderr(`${error.message}\n`);
    return 1;
  }
};

/** Large imports can take minutes; the Environment owns each service's bounds. */
const IMPORT_WAIT_MS = 15 * 60_000;

/** Preview listed directories before adoption. Older Environments still expose adopted Accounts' inventories. */
const accountInventories = async (call: LocalCall): Promise<StateImportAccountInventories> => {
  let inventories: StateImportAccountInventories = { accounts: [], failed: [], later: [] };
  try {
    const preview = await call("carryOver.inventory", { source: "state-import" });
    if ("accounts" in preview) inventories = preview;
  } catch (error) {
    if (!(error instanceof LocalRefusal) || !["unsupported", "invalid_params", "not_found"].includes(error.error.code)) throw error;
  }
  const { accounts } = await call("accounts.list", {});
  for (const account of accounts) {
    if (account.directory.kind !== "adopted" || inventories.accounts.some((entry) => entry.accountId === account.id)) continue;
    let inventory: CarryOverInventory | null = null;
    let failure: string | null = null;
    try {
      const answer = await call("carryOver.inventory", { accountId: account.id });
      if (!("accountId" in answer)) throw new LocalFailure("The environment answered the Account inventory without its counts.");
      inventory = answer;
    } catch (error) {
      if (!(error instanceof LocalRefusal)) throw error;
      failure = error.message;
    }
    inventories.accounts.push({ sourceId: account.id, label: account.label, accountId: account.id, inventory, failure });
  }
  return inventories;
};

const renderReport = (report: StateImportReport, inventory: StateImportAccountInventories | null): string => {
  const lines = [report.dryRun ? "State import preview" : "State import applied", "", "Account inventory (before import)"];
  for (const entry of inventory?.accounts ?? []) {
    lines.push(`  ${entry.label} (${entry.accountId ?? entry.sourceId})`);
    if (entry.sharedProjectsWith !== undefined) {
      const owner = inventory?.accounts.find((account) => account.sourceId === entry.sharedProjectsWith)?.label ?? "another source profile";
      lines.push(`    Shared projects folder with ${owner}; sessions and memory offered once.`);
    }
    if (entry.failure !== null) lines.push(`    Failed: ${entry.failure}`);
    const counts = entry.inventory;
    if (counts === null) continue;
    lines.push(
      `    Sessions: ${counts.sessions.total}; new: ${counts.sessions.new}; archived: ${counts.sessions.archived}; missing directory: ${counts.sessions.missingDirectory}`,
      `    Memory: ${counts.memory.folders} folders; repositories: ${counts.memory.repositories}; new: ${counts.memory.new}`,
      `    Skills: ${counts.skills.skills}; commands: ${counts.skills.commands}; new: ${counts.skills.new}; invalid: ${counts.skills.invalid}`,
    );
    for (const folder of counts.memory.unmappable) lines.push(`      Memory unmappable: ${folder.folder}; Step: carry-over`);
    for (const offer of counts.skills.offered) lines.push(`      Skill source offered: ${offer.name}; Step: skills`);
    for (const item of counts.notCarried) lines.push(`      Not carried: ${item.kind} ${item.name}`);
    lines.push(`    Not carried: hooks: ${counts.doesNotCarry.hooks}; MCP servers: ${counts.doesNotCarry.mcpServers}; permission rules: ${counts.doesNotCarry.permissionRules}`);
  }
  for (const failure of inventory?.failed ?? []) lines.push(`  Failed: ${failure.label}: ${failure.message}`);
  for (const item of inventory?.later ?? []) lines.push(`  Later: ${item.label} (${item.provider})`);
  for (const source of report.sharedProjects ?? []) lines.push(`  ${source.label} shares a projects folder with ${source.ownerLabel}: its sessions and memory carry once, with ${source.ownerLabel}, and not again with ${source.label}.`);
  lines.push("", "Carried");
  for (const [kind, count] of Object.entries(report.carried)) lines.push(`  ${kind}: ${count}`);
  lines.push("", "Re-enter");
  for (const item of report.reEnter) lines.push(`  ${item.label}; Step: ${item.step}`);
  if (report.reEnter.length === 0) lines.push("  None");
  lines.push("", "Later (milestone 2)");
  for (const item of report.later) lines.push(`  ${item.label} (${item.provider})`);
  if (report.later.length === 0) lines.push("  None");
  lines.push("", "Not carried");
  for (const item of report.notCarried) lines.push(`  ${item.label}: ${item.count}${item.step === null ? "" : `; Step: ${item.step}`}`);
  if (report.notCarried.length === 0) lines.push("  None");
  lines.push("", "Failed");
  for (const failure of report.failed) lines.push(`  ${failure.label}: ${failure.message}`);
  if (report.failed.length === 0) lines.push("  None");
  else lines.push(`  Repair the failed items, then run ${PRODUCT_NAME} state-import again.`);
  lines.push("", "Client-local values (unapplied)");
  for (const [key, value] of Object.entries(report.clientLocal)) lines.push(`  ${key}: ${String(value)}`);
  if (Object.keys(report.clientLocal).length === 0) lines.push("  None");
  return `${lines.join("\n")}\n`;
};
