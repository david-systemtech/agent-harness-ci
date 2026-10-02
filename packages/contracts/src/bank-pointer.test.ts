import { describe, expect, it } from "vitest";
import { formatBankPointer, parseBankPointer, type BankPointer } from "./banks.js";

describe("the bank pointer syntax", () => {
  it.each<[string, BankPointer]>([
    ["maya-memory", { kind: "bank", bank: "maya-memory" }],
    ["maya-memory:personal/", { kind: "folder", bank: "maya-memory", path: "personal/" }],
    ["maya-memory:personal/homelab/", { kind: "folder", bank: "maya-memory", path: "personal/homelab/" }],
    ["maya-memory:personal/homelab/nas/", { kind: "folder", bank: "maya-memory", path: "personal/homelab/nas/" }],
    ["maya-memory:personal/homelab/memories/deploys/", { kind: "folder", bank: "maya-memory", path: "personal/homelab/memories/deploys/" }],
    ["maya-memory:personal/homelab/nas/memories/disks/", { kind: "folder", bank: "maya-memory", path: "personal/homelab/nas/memories/disks/" }],
    ["maya-memory:backup-schedule", { kind: "memory", bank: "maya-memory", name: "backup-schedule" }],
  ])("reads %s and prints it back the same", (text, pointer) => {
    expect(parseBankPointer(text)).toEqual(pointer);
    expect(formatBankPointer(pointer)).toBe(text);
  });

  it("reads a bank named with a trailing colon, or with spaces round it, as the bank, and prints its one form", () => {
    expect(parseBankPointer("notebook:")).toEqual({ kind: "bank", bank: "notebook" });
    expect(parseBankPointer("  notebook:homelab/  ")).toEqual({ kind: "folder", bank: "notebook", path: "homelab/" });
    expect(formatBankPointer({ kind: "bank", bank: "notebook" })).toBe("notebook");
  });

  it.each([
    "",
    "Notebook",
    "notebook:Backup Schedule",
    "notebook:/homelab/",
    "notebook:homelab//",
    "notebook:memories/",
    "notebook:homelab/memories/",
    "notebook:homelab/gamingpc/memories/",
    "notebook:homelab/gamingpc/memories/Deploys/",
    "notebook:homelab/gamingpc/memories/llm/extra/",
    "notebook:homelab/gamingpc/rx6800/extra/",
    "notebook:homelab/memories/llm/",
    "notebook:homelab/gamingpc/rx6800/memories/llm/extra/",
    "notebook:homelab:gamingpc/",
    "notebook:home lab/",
    "a-bank-name-of-forty-one-characters-long-x:fact",
  ])("refuses %j, which names no bank, folder, topic or memory", (text) => {
    expect(parseBankPointer(text)).toBeNull();
  });
});
