import { SCOPES } from "@agent-harness/contracts";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { offeredPresets } from "./presets.js";

it("maps the phone instructions' visible pairing choices to the working CLI presets", async () => {
  const { presets } = offeredPresets("bypassPermissions", SCOPES);
  for (const path of ["README.md", "docs/phone.md"]) {
    const doc = await readFile(new URL(`../../../../${path}`, import.meta.url), "utf8");
    for (const id of ["own-client", "phone", "custom"] as const) {
      const choice = presets.find(({ preset }) => preset.id === id);
      expect(choice).toBeDefined();
      const row = doc.split("\n").find((line) => line.startsWith("| ") && line.includes(`--preset ${id}`));
      expect(row, `${path}: ${id} must map its visible choice to the CLI command`).toBeDefined();
      expect(row, `${path}: ${id} uses the shipped visible label`).toContain(`**${choice?.label}**`);
    }
    expect(doc, path).toContain("**A program or bot**");
    expect(doc, path).not.toContain("My own client");
    expect(doc, path).not.toContain("Pair a client");
  }
});

it("keeps pairing and upgrade directions explicit without changing the phone grants", async () => {
  for (const path of ["README.md", "docs/phone.md"]) {
    const original = await readFile(new URL(`../../../../${path}`, import.meta.url), "utf8");
    const doc = original.replace(/\s+/g, " ");
    expect(doc, path).toContain("Settings → Settings rows → Your machines");
    expect(doc, path).toContain("**Pair another client**");
    expect(doc, path).toContain("**Who is it for?**");
    expect(doc, path).toContain("**More options → Custom**");
    expect(doc, path).toContain("**Make a pairing code**");
    expect(doc, path).toContain("**Give this phone full access**");
    expect(doc, path).toContain("**Full access**");
    expect(doc, path).toContain("**Restricted phone**");
    for (const [id, scopes, ceiling] of [
      ["own-client", ["read", "sessions:write", "runs:drive", "terminal", "admin"], "bypassPermissions"],
      ["phone", ["read", "sessions:write", "runs:drive"], "acceptEdits"],
    ] as const) {
      const row = original.split("\n").find((line) => line.startsWith("| ") && line.includes(`--preset ${id}`));
      for (const scope of scopes) expect(row, `${path}: ${id} preserves ${scope}`).toContain(`\`${scope}\``);
      expect(row, `${path}: ${id} preserves its ceiling`).toContain(`\`${ceiling}\``);
    }
  }
});
