import { DATA_DIRECTORY_PRESET_ID, describeDenylistMatch, PromptOpenedPayload, type DenylistMatch, type PromptAnsweredPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { denylistCardWords, denylistMatchWords, denylistRepeatWords } from "./denylist.js";

/**
 * What a denylist prompt's card says beside its answers (#1820): the entry
 * the call matched in words, what the agent may do instead, and, when the
 * run asked about the same entry before, that it is the same one.
 */

const RUN = "0199a100-0000-4000-8000-000000000001";

const match = (fields: Partial<DenylistMatch["entry"]> & { readonly section?: DenylistMatch["section"]; readonly matched?: string } = {}): DenylistMatch => {
  const { section = "paths", matched = "/srv/harness/events.db", ...entry } = fields;
  return { section, matched, entry: { id: DATA_DIRECTORY_PRESET_ID, pattern: "/srv/harness", note: "The harness's own data directory: its event log, keys and accounts.", preset: true, enabled: true, ...entry } };
};

const denylisted = (promptId: string, matches: readonly DenylistMatch[], runId = RUN): PromptOpenedPayload =>
  PromptOpenedPayload.parse({
    runId,
    promptId,
    kind: "denylist",
    toolName: "Bash",
    toolCallId: null,
    input: { command: "ls /srv/harness" },
    summary: "Bash: ls /srv/harness",
    blockedPath: null,
    reason: null,
    questions: null,
    plan: null,
    suggestions: [],
    agentId: null,
    denylist: matches,
    mode: "bypassPermissions",
    ceiling: "bypassPermissions",
    ttlExpiresAt: null,
  });

const answered = (prompt: PromptOpenedPayload, decision: "allow" | "deny"): { readonly prompt: PromptOpenedPayload; readonly answer: Pick<PromptAnsweredPayload, "decision"> } => ({ prompt, answer: { decision } });
const parked = (prompt: PromptOpenedPayload) => ({ prompt, answer: null });

describe("an entry in words", () => {
  it("names the data directory as the environment's, with what it holds and what the agent may do instead", () => {
    const words = denylistMatchWords(match());
    expect(words.protects).toBe("This is the environment's data directory: its event log, keys and accounts.");
    expect(words.instead).toMatch(/^Instead, the agent may /);
    expect(words.instead).not.toContain("denylist");
  });

  it("names another entry by its pattern and note, and says what the agent may do instead by its section", () => {
    const ssh = denylistMatchWords(match({ id: "preset:~/.ssh", pattern: "~/.ssh", note: "SSH keys and known hosts.", matched: "~/.ssh/id_ed25519" }));
    expect(ssh.protects).toBe("Entry ~/.ssh: SSH keys and known hosts.");
    expect(ssh.instead).toMatch(/^Instead, the agent may .*path/);
    const sudo = denylistMatchWords(match({ id: "preset:sudo *", pattern: "sudo *", note: "Runs a command as another user, root among them.", section: "commandPatterns", matched: "sudo ls" }));
    expect(sudo.instead).toMatch(/run it yourself/);
    expect(denylistMatchWords(match({ id: "keys", pattern: "/srv/keys/**", note: " ", preset: false })).protects).toBe("Entry /srv/keys/**, on the denylist's paths with no note.");
    for (const section of ["browserDomains", "hosts"] as const) expect(denylistMatchWords(match({ id: "x", pattern: "*.example.test", note: "", section })).instead).toMatch(/^Instead, the agent may /);
  });
});

describe("a card that says each thing once (#1905)", () => {
  // As the environment's gate asks it: the summary and the reason both name the first match.
  const gated = (toolName: string, matches: readonly DenylistMatch[]): PromptOpenedPayload => {
    const [first] = matches;
    const named = first === undefined ? "" : describeDenylistMatch(first);
    return { ...denylisted("0199a100-0000-4000-8000-0000000000f1", matches), toolName, summary: `${toolName}: ${named}`, reason: matches.length > 1 ? `${named}, and ${matches.length - 1} more` : named };
  };

  it("names what was asked, then why the one entry is on the denylist, then what the agent may do instead, without the entry's sentence again", () => {
    const card = denylistCardWords(gated("Read", [match({ pattern: "/data", matched: "/data/environment.json" })]));
    expect(card).toEqual({
      asked: "Read: /data/environment.json",
      entries: [{ heading: undefined, protects: "This is the environment's data directory: its event log, keys and accounts.", instead: expect.stringMatching(/^Instead, the agent may work in its own working directory/) }],
    });
  });

  it("names one thing the call touched once, beside each entry it matched", () => {
    const ssh = match({ id: "preset:~/.ssh", pattern: "~/.ssh/**", note: "SSH keys.", matched: "/srv/harness/.ssh/id" });
    const card = denylistCardWords(gated("Read", [match({ matched: "/srv/harness/.ssh/id" }), ssh]));
    expect(card?.asked).toBe("Read: /srv/harness/.ssh/id");
    expect(card?.entries.map((entry) => [entry.heading, entry.protects])).toEqual([
      [undefined, "This is the environment's data directory: its event log, keys and accounts."],
      [undefined, "Entry ~/.ssh/**: SSH keys."],
    ]);
  });

  it("lists each match once, saying which thing matched which entry when the call touched several", () => {
    const data = match({ matched: "/srv/harness/events.db" });
    const sudo = match({ id: "preset:sudo *", pattern: "sudo *", note: "Runs a command as another user.", section: "commandPatterns", matched: "sudo cat /srv/harness/events.db" });
    const card = denylistCardWords(gated("Bash", [data, sudo, data]));
    expect(card?.asked).toBe("Bash: /srv/harness/events.db, sudo cat /srv/harness/events.db");
    expect(card?.entries.map((entry) => entry.heading)).toEqual([describeDenylistMatch(data), describeDenylistMatch(sudo)]);
  });

  it("names a long or many-line thing the call touched on one short line, as the entry's sentence quotes it", () => {
    const heredoc = `sudo tee /etc/x <<EOF\n${"a line of the heredoc\n".repeat(200)}EOF`;
    const sudo = match({ id: "preset:sudo *", pattern: "sudo *", note: "Runs a command as another user.", section: "commandPatterns", matched: heredoc });
    expect(denylistCardWords(gated("Bash", [sudo]))?.asked).toBe("Bash: sudo tee /etc/x <<EOF");
    const long = match({ id: "preset:sudo *", pattern: "sudo *", note: "Runs a command as another user.", section: "commandPatterns", matched: `sudo ${"x".repeat(100)}` });
    const asked = denylistCardWords(gated("Bash", [long]))?.asked;
    expect(asked).toBe(`Bash: sudo ${"x".repeat(54)}…`);
    expect(describeDenylistMatch(long)).toContain(asked?.slice("Bash: ".length));
  });

  it("leaves a prompt with no match, or of another kind, to its summary and reason", () => {
    expect(denylistCardWords(gated("Read", []))).toBeUndefined();
    expect(denylistCardWords({ ...gated("Read", [match()]), kind: "permission" })).toBeUndefined();
  });
});

describe("the same entry again within the run", () => {
  const first = denylisted("p-1", [match()]);
  const again = denylisted("p-2", [match({ matched: "/srv/harness/sessions" })]);

  it("says nothing the first time", () => {
    expect(denylistRepeatWords(first, [parked(first)])).toBeUndefined();
  });

  it("says it is the same entry as before, how often the run asked and the last answer", () => {
    expect(denylistRepeatWords(again, [answered(first, "deny"), parked(again)])).toBe("The same entry as before: this run already asked about /srv/harness once (last denied).");
    const third = denylisted("p-3", [match()]);
    expect(denylistRepeatWords(third, [answered(first, "deny"), answered(again, "allow"), parked(third)])).toBe("The same entry as before: this run already asked about /srv/harness twice (last allowed).");
  });

  it("counts only the same run's earlier prompts on a shared entry", () => {
    const otherRun = denylisted("p-0", [match()], "0199a100-0000-4000-8000-000000000002");
    const otherEntry = denylisted("p-1", [match({ id: "preset:~/.ssh", pattern: "~/.ssh" })]);
    const later = denylisted("p-9", [match()]);
    expect(denylistRepeatWords(again, [answered(otherRun, "deny"), answered(otherEntry, "deny"), parked(again), parked(later)])).toBeUndefined();
    expect(denylistRepeatWords(later, [parked(again), parked(later)])).toBe("The same entry as before: this run already asked about /srv/harness once.");
  });
});
