import { describe, expect, it } from "vitest";
import { changed, FAKE_GITHUB_TOKEN, markdown, memory, PERSONAL_BANK, personalManifest, RULE_FIXTURES, scopeFile, TEAM_BANK } from "../test/fixture-banks.js";
import { validateBank } from "./bank-validator.js";
import { BANK_VALIDATOR_RULES } from "./banks.js";

describe("the bank validator", () => {
  it.each([
    ["personal", PERSONAL_BANK],
    ["team", TEAM_BANK],
  ])("passes a %s bank on the contract, at every cap's edge, with no finding", (_, files) => {
    expect(validateBank({ files })).toEqual({ validator: { name: "bank-validator", version: 1 }, valid: true, findings: [] });
  });

  it.each(BANK_VALIDATOR_RULES.map((rule) => [rule.id, rule] as const))("finds %s in the bank that breaks it once, with the path, the rule's severity and a message", (id, rule) => {
    const { bank, path } = RULE_FIXTURES[id];
    const { valid, findings } = validateBank({ files: bank });
    expect(findings.map((each) => each.rule)).toEqual(findings.map(() => id));
    expect(findings).toContainEqual(expect.objectContaining({ rule: id, severity: rule.severity, path, message: expect.stringMatching(/\S/) }));
    expect(valid).toBe(rule.severity === "warning");
  });

  it("refuses a write over a folder's 40 lines with the folder's existing topics, and passes it filed under a topic", () => {
    const web = "projects/acme/web/";
    // Thirty-eight memories and two topics: forty lines.
    const files = changed(TEAM_BANK, {
      [`${web}PROJECT.md`]: scopeFile("The storefront", { checkout: "Before touching checkout - payments and taxes", theme: "When editing the theme - sections and assets" }),
      [`${web}memories/storefront-fact-39.md`]: null,
      [`${web}memories/storefront-fact-40.md`]: null,
    });
    expect(validateBank({ files }).valid).toBe(true);
    const over = validateBank({ files, writes: { [`${web}memories/storefront-fact-41.md`]: memory("storefront-fact-41") } });
    expect(over.findings).toEqual([
      expect.objectContaining({
        rule: "index_over_cap",
        path: web,
        message: "projects/acme/web/ indexes 41 lines: at most 40. Its topics are checkout and theme: file the memory under one of them, or declare a new topic in PROJECT.md's topics:.",
      }),
    ]);
    expect(validateBank({ files, writes: { [`${web}memories/checkout/storefront-fact-41.md`]: memory("storefront-fact-41") } })).toMatchObject({ valid: true, findings: [] });
  });

  it("refuses a new scope folder past 40 root breadcrumbs until the root is re-tiered to orgs, then caps each org the same way", () => {
    const { bank } = RULE_FIXTURES.root_over_cap;
    expect(validateBank({ files: bank }).findings).toEqual([
      expect.objectContaining({ rule: "root_over_cap", path: "projects/", message: expect.stringContaining("Re-tier the root to orgs with root: orgs in BANK.md.") }),
    ]);
    const retiered = { ...bank, "BANK.md": markdown(personalManifest({ root: "orgs" })) };
    expect(validateBank({ files: retiered }).findings).toEqual([expect.objectContaining({ rule: "root_over_cap", path: "projects/personal/" })]);
    const split = Object.fromEntries(Object.entries(retiered).map(([path, text]) => [path.replace(/^projects\/personal\/side-0/, "projects/side/side-0"), text]));
    expect(validateBank({ files: { ...split, "projects/side/ORG.md": markdown({ line: "Side projects" }) } })).toMatchObject({ valid: true, findings: [] });
  });

  it("counts orientation in UTF-8 bytes, so multibyte text reaches the 600-byte cap in fewer characters, and caps all of it at 1,500", () => {
    const path = "projects/personal/memory-bank/memories/machines-at-a-glance.md";
    const threeBytes = memory("machines-at-a-glance", { description: "When a task names a machine - Maya's machines at a glance, one line each, with pointers", type: "reference", body: "日".repeat(201) });
    expect(validateBank({ files: { ...PERSONAL_BANK, [path]: threeBytes } }).findings).toEqual([
      expect.objectContaining({ rule: "orientation_too_large", path, message: `${path} is an orientation memory of 603 bytes: at most 600. Make it a short pointer to the longer memories.` }),
    ]);
    const atCap = memory("machines-at-a-glance", { description: "When a task names a machine - Maya's machines at a glance, one line each, with pointers", type: "reference", body: "日".repeat(200) });
    const third = "projects/personal/memory-bank/memories/backup-keys.md";
    const files = { ...PERSONAL_BANK, [path]: atCap, [third]: memory("backup-keys", { description: "Before restoring a backup - where its keys are and who holds them", body: "x".repeat(301) }), "BANK.md": markdown(personalManifest({ orientation: ["secrets-layout", "machines-at-a-glance", "backup-keys"] })) };
    expect(validateBank({ files }).findings).toEqual([expect.objectContaining({ rule: "orientation_too_large", path: "BANK.md", message: "BANK.md's orientation memories are 1,501 bytes in all: at most 1,500." })]);
  });

  it("names a secret's rule and field and never its value, for a shape and for a value the environment registers", () => {
    const path = "projects/personal/homelab/memories/backup-schedule.md";
    const shaped = validateBank({ files: RULE_FIXTURES.secret_shaped.bank });
    expect(shaped.findings).toEqual([expect.objectContaining({ rule: "secret_shaped", path, field: "body", secret: "github" })]);
    expect(JSON.stringify(shaped)).not.toContain(FAKE_GITHUB_TOKEN);
    const registered = "correct-horse-battery-staple";
    const files = { ...PERSONAL_BANK, [path]: memory("backup-schedule", { description: `When a backup is missing - the nightly schedule, run as ${registered}` }) };
    expect(validateBank({ files }).valid).toBe(true);
    const held = validateBank({ files, registeredValues: [registered] });
    expect(held.findings).toEqual([
      { rule: "secret_shaped", severity: "refusal", path, field: "description", secret: "registered-value", message: `${path}'s description holds a secret this environment holds: take it out, keep it in the key manager and name its path instead.` },
    ]);
    expect(JSON.stringify(held)).not.toContain(registered);
  });

  it("judges a write by what it touches and what it breaks, not by what was wrong elsewhere before it", () => {
    const broken = { ...PERSONAL_BANK, "projects/personal/homelab/nas/AREA.md": markdown({ line: "The NAS" }) };
    const draft = "projects/personal/homelab/memories/disk-alerts.md";
    expect(validateBank({ files: broken, writes: { [draft]: memory("disk-alerts", { description: "When a disk alert fires on the NAS - what each alert means and who acts" }) } })).toMatchObject({ valid: true, findings: [] });
    expect(validateBank({ files: broken, writes: { [draft]: memory("disk-alerts", { description: "Alerts on the NAS." }) } }).findings.map((each) => each.rule)).toEqual(["description_length", "description_trigger"]);
    const retired = validateBank({ files: PERSONAL_BANK, writes: { "projects/personal/memory-bank/memories/secrets-layout.md": null } });
    expect(retired.findings).toEqual([expect.objectContaining({ rule: "orientation_missing", path: "BANK.md" })]);
  });

  it("reads trigger words, links and re-cased names whatever the case and punctuation", () => {
    const path = "projects/personal/homelab/memories/backup-schedule.md";
    const files = { ...PERSONAL_BANK, [path]: memory("backup-schedule", { description: "before a restore: the nightly schedule, its logs and the drive it writes to", body: "See [[nas-disk-layout]] and [[ rollback-steps ]].\n" }) };
    expect(validateBank({ files })).toMatchObject({ valid: true, findings: [] });
  });
});
