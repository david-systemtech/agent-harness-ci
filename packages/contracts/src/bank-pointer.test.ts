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
    expect(parseBankPointer("cortex:")).toEqual({ kind: "bank", bank: "cortex" });
    expect(parseBankPointer("  cortex:homelab/  ")).toEqual({ kind: "folder", bank: "cortex", path: "homelab/" });
    expect(formatBankPointer({ kind: "bank", bank: "cortex" })).toBe("cortex");
  });

  it.each([
    "",
    "Cortex",
    "cortex:Backup Schedule",
    "cortex:/homelab/",
    "cortex:homelab//",
    "cortex:memories/",
    "cortex:homelab/memories/",
    "cortex:homelab/gamingpc/memories/",
    "cortex:homelab/gamingpc/memories/Deploys/",
    "cortex:homelab/gamingpc/memories/llm/extra/",
    "cortex:homelab/gamingpc/rx6800/extra/",
    "cortex:homelab/memories/llm/",
    "cortex:homelab/gamingpc/rx6800/memories/llm/extra/",
    "cortex:homelab:gamingpc/",
    "cortex:home lab/",
    "a-bank-name-of-forty-one-characters-long-x:fact",
  ])("refuses %j, which names no bank, folder, topic or memory", (text) => {
    expect(parseBankPointer(text)).toBeNull();
  });
});
