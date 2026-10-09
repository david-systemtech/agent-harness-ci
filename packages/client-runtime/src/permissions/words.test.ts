import { CONTAINMENT_CAUSES, MODES, type ContainmentAvailability, type ContainmentCause } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { MODE_WORDS, PROMPT_TIMEOUT_CHOICES, SANDBOX_LEVEL_WORDS, promptTimeoutChoices, sandboxReadiness, sandboxSetup } from "./words.js";

/**
 * The Permissions step's words as both renderers say them (setup-copy.md
 * §5.12; #1858): the four choices of how much agents may do without asking,
 * the sandbox's levels with Works here or Needs setup and how to set one up
 * by the probe's cause, and the timeout of a question nobody answers.
 */

const refused = (cause: ContainmentCause): Extract<ContainmentAvailability, { readonly available: false }> => ({ level: "workspace", available: false, reason: `The probe says no (${cause}).`, cause });

describe("the mode choices", () => {
  it("name every mode in §5.12's words, its id kept for Details", () => {
    expect(MODES.map((mode) => [mode, MODE_WORDS[mode].label])).toEqual([
      ["plan", "Ask before any change"],
      ["acceptEdits", "Edit files, ask for the rest"],
      ["auto", "Let Claude decide"],
      ["bypassPermissions", "Never ask"],
    ]);
    expect(MODE_WORDS.acceptEdits.note).toBe("Agents can edit files in your project. They ask before running commands.");
    expect(MODE_WORDS.bypassPermissions.note).toBe("Agents act without asking. Use it only for trusted work in a sandbox.");
  });
});

describe("the sandbox", () => {
  it("names each level in §5.12's words and says whether it works here", () => {
    expect(SANDBOX_LEVEL_WORDS).toEqual({ off: "Off", workspace: "Project folder", "workspace-no-network": "Project folder, no internet" });
    expect(sandboxReadiness({ level: "off", available: true, reason: null, cause: null })).toBe("Works here");
    expect(sandboxReadiness(refused("binary_missing"))).toBe("Needs setup");
    expect(sandboxReadiness(undefined)).toBe("Needs setup");
  });

  it("gives the OS's commands to copy for what the machine itself can fix, then the restart that probes it again", () => {
    expect(sandboxSetup(refused("binary_missing"), false)).toEqual({
      line: "Install bubblewrap and socat, the two programs the sandbox uses on Linux.",
      commands: [
        { label: "On Ubuntu or Debian", text: "sudo apt-get install bubblewrap socat" },
        { label: "On Fedora", text: "sudo dnf install bubblewrap socat" },
        { label: "On Arch Linux", text: "sudo pacman -S bubblewrap socat" },
      ],
      restart: { label: "Then restart agent-harness, which checks the sandbox as it starts", text: "agent-harness service stop && agent-harness service start" },
    });
    expect(sandboxSetup(refused("socat_missing"), false).commands).toEqual(sandboxSetup(refused("binary_missing"), false).commands);
    expect(sandboxSetup(refused("apparmor"), false)).toMatchObject({
      line: "Ubuntu needs a rule that lets the sandbox start. Add it with this command.",
      commands: [{ label: "Add the rule", text: expect.stringContaining("sudo tee /etc/apparmor.d/bwrap") as unknown as string }],
    });
    expect(sandboxSetup(refused("userns_blocked"), false).commands[0]?.text).toContain("sudo sysctl --system");
  });

  it("restarts a container with docker compose, and says what a container's seccomp profile needs", () => {
    expect(sandboxSetup(refused("binary_missing"), true).restart).toEqual({ label: "Then restart agent-harness, which checks the sandbox as it starts", text: "docker compose restart environment" });
    expect(sandboxSetup(refused("seccomp"), true)).toMatchObject({ line: "The container's security profile stops the sandbox. Start the container with a seccomp profile that allows user namespaces.", commands: [] });
  });

  it("gives no command where nothing on the machine helps, and a restart alone where the probe has not run", () => {
    expect(sandboxSetup(refused("platform"), false)).toEqual({ line: "This computer has no sandbox agent-harness can use. On Windows, run agent-harness in WSL2 to use one.", commands: [] });
    expect(sandboxSetup(refused("adapter"), false)).toEqual({ line: "The agent this computer runs cannot use a sandbox.", commands: [] });
    for (const cause of ["probe_failed", "not_probed"] as const) {
      expect(sandboxSetup(refused(cause), false)).toMatchObject({ line: "agent-harness has not checked the sandbox here yet.", commands: [], restart: { text: "agent-harness service stop && agent-harness service start" } });
    }
    // Every cause has its words: a new one fails here until it has.
    for (const cause of CONTAINMENT_CAUSES) expect(sandboxSetup(refused(cause), false).line, cause).not.toBe("");
  });
});

describe("the timeout of a question nobody answers", () => {
  it("offers §5.12's four choices, the 24 hours preset among them", () => {
    expect(PROMPT_TIMEOUT_CHOICES.map((choice) => [choice.label, choice.value])).toEqual([
      ["1 hour", { amount: 1, unit: "hours" }],
      ["24 hours", { amount: 24, unit: "hours" }],
      ["2 days", { amount: 2, unit: "days" }],
      ["Never deny it", "never"],
    ]);
  });

  it("keeps a value set elsewhere as a choice of its own, so choosing nothing changes nothing", () => {
    expect(promptTimeoutChoices({ amount: 24, unit: "hours" })).toBe(PROMPT_TIMEOUT_CHOICES);
    expect(promptTimeoutChoices("never")).toBe(PROMPT_TIMEOUT_CHOICES);
    expect(promptTimeoutChoices({ amount: 30, unit: "minutes" }).map((choice) => choice.label)).toEqual(["30 minutes", "1 hour", "24 hours", "2 days", "Never deny it"]);
    expect(promptTimeoutChoices({ amount: 1, unit: "days" }).map((choice) => choice.label)[0]).toBe("1 day");
  });
});
