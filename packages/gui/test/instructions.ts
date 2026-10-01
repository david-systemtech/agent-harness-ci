import { CATALOGUE, keyBetween, OwnedInstruction, type InstructionAccount, type OwnedInstructionRow, type ResultOf } from "@agent-harness/contracts";
import type { EnvironmentHandle } from "./harness.js";

export const INSTRUCTION_ACCOUNT: InstructionAccount = {
  accountId: "account-1",
  label: "Main account",
  channel: { kind: "system-prompt-append", maxCharacters: null },
  reason: null,
};
export const NO_CHANNEL_ACCOUNT: InstructionAccount = {
  accountId: "account-2",
  label: "Other account",
  channel: { kind: "none", maxCharacters: null },
  reason: "This adapter has no instruction channel.",
};
export const ownedInstruction = (fields: Partial<OwnedInstructionRow> = {}): OwnedInstructionRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Review habits",
  body: "Read every comment.",
  origin: null,
  scope: "all",
  enabled: true,
  position: "m",
  newerVersion: null,
  accounts: [INSTRUCTION_ACCOUNT, NO_CHANNEL_ACCOUNT],
  ...fields,
});

/** The scripted peer's owned state, changed only by wire commands or another client's notice. */
export const scriptInstructions = (environment: EnvironmentHandle, initial: readonly OwnedInstructionRow[] = [], diff?: Partial<ResultOf<"instructions.diff">>) => {
  let rows = [...initial];
  let dismissed: string[] = [];
  let sequence = 0;
  const updated = () => environment.notice("instructions.updated", {});
  environment.wire.answer("instructions.list", () => ({
    result: {
      orientation: { enabled: true, text: "# Orientation\nForge: verified on this environment.", unreadRegistries: [], accounts: [INSTRUCTION_ACCOUNT, NO_CHANNEL_ACCOUNT] },
      instructions: rows,
      dismissed,
    },
  }));
  const methods = ["create", "edit", "setEnabled", "setScope", "move", "remove", "resolveVersion", "dismissSuggestion", "restoreSuggestion"] as const;
  for (const verb of methods)
    environment.wire.answer(`instructions.${verb}`, (params) => {
      let row = rows.find((held) => held.id === params["instructionId"]);
      const entry = CATALOGUE.instructions.entries.find((held) => held.id === (params["catalogueId"] ?? row?.origin?.catalogueId));
      let result: Record<string, unknown> = {};
      switch (verb) {
        case "create":
          row = ownedInstruction({
            ...OwnedInstruction.parse({
              ...params,
              title: entry?.title ?? params["title"],
              body: entry?.text ?? params["body"],
              origin: entry === undefined ? null : { catalogueId: entry.id, version: entry.version },
              scope: params["scope"] ?? "all",
              enabled: true,
              position: keyBetween(rows.at(-1)?.position ?? null, null),
            }),
          });
          rows.push(row);
          dismissed = dismissed.filter((id) => id !== entry?.id);
          break;
        case "edit":
          if (row !== undefined) row = { ...row, title: String(params["title"]), body: String(params["body"]) };
          break;
        case "setEnabled":
          if (row !== undefined) row = { ...row, enabled: Boolean(params["enabled"]) };
          break;
        case "setScope":
          if (row !== undefined) row = { ...row, scope: OwnedInstruction.shape.scope.parse(params["scope"]) };
          break;
        case "move":
          if (row !== undefined) row = { ...row, position: String(params["position"]) };
          break;
        case "remove":
          rows = rows.filter((held) => held.id !== row?.id);
          if (row?.origin !== null && row?.origin !== undefined && !rows.some((held) => held.origin?.catalogueId === row?.origin?.catalogueId))
            dismissed.push(row.origin.catalogueId);
          result = { instructionId: params["instructionId"] };
          row = undefined;
          break;
        case "resolveVersion":
          if (row !== undefined && entry !== undefined)
            row = {
              ...row,
              body: params["choice"] === "replace" ? (diff?.to ?? entry.text) : row.body,
              origin: { catalogueId: entry.id, version: diff?.toVersion ?? entry.version },
              newerVersion: null,
            };
          result = { changed: true };
          break;
        case "dismissSuggestion":
          dismissed.push(String(params["catalogueId"]));
          result = { catalogueId: params["catalogueId"], changed: true };
          break;
        case "restoreSuggestion":
          dismissed = dismissed.filter((id) => id !== params["catalogueId"]);
          result = { catalogueId: params["catalogueId"], changed: true };
          break;
      }
      if (row !== undefined) {
        rows = rows.map((held) => (held.id === row?.id ? row : held));
        result = { ...result, instruction: OwnedInstruction.parse(row) };
      }
      rows.sort((a, b) => a.position.localeCompare(b.position));
      updated();
      return { result: { receipt: { status: "accepted", sequence: ++sequence, changed: true }, result } };
    });
  environment.wire.answer("instructions.diff", (params) => {
    const row = rows.find((held) => held.id === params["instructionId"]);
    const entry = CATALOGUE.instructions.entries.find((held) => held.id === row?.origin?.catalogueId);
    const result: ResultOf<"instructions.diff"> = {
      catalogueId: entry?.id ?? "coding.fresh-checkout",
      fromVersion: row?.origin?.version ?? 1,
      toVersion: entry?.version ?? 1,
      from: "The earlier source text.",
      to: entry?.text ?? "",
      body: row?.body ?? "",
      ...diff,
    };
    return { result };
  });
  return {
    change(next: readonly OwnedInstructionRow[]) {
      rows = [...next];
      updated();
    },
  };
};
