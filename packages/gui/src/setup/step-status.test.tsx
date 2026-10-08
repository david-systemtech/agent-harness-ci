import { screen, waitFor, within } from "@testing-library/react";
import { STEP_ORDER } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment, type ScriptedSetup } from "../../test/harness.js";
import { StepStatus } from "./step-status.js";

/**
 * A step's status at the head of its card, and the reach line above the
 * checklist (setup-copy.md §3, "Status line" and the patterns; #1840): the
 * state word, the line, a result needing a fix as a notice with its fixes in
 * place and Details, one Check again, Open in Settings saying it leaves Set
 * up, and a check or a start that did not run said with Details.
 */

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** Settings, open. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Every step done but Account's, which the first launch would hold on, as the script says the rest. */
const onlySteps = (results: ScriptedSetup): ScriptedSetup => ({ ...Object.fromEntries(STEP_ORDER.map((step) => [step, null])), account: {}, ...results });

/** A first launch on this machine's environment, `desk`, as `given` scripts it, the Skills step drawn by the status alone; `before` runs ahead of Begin set up. */
const firstLaunch = async (given: Partial<ScriptedEnvironment> = {}, before: (app: RenderedApp) => void = () => {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given }] }, { firstLaunch: true, stepCards: { skills: StepStatus, forges: StepStatus } });
  const begin = await screen.findByRole("button", { name: "Begin set up" });
  before(app);
  await app.user.click(begin);
  await screen.findByRole("region", { name: "Set up" });
  return app;
};

/** The card of `step` in the checklist, chosen on its rail. */
const cardOf = async (app: RenderedApp, step: string) => {
  await app.user.click(within(within(checklist()).getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: step }));
  return within(checklist()).getByRole("region", { name: step });
};

/** What a Details fold inside `within` shows, opened. */
const detailsIn = async (app: RenderedApp, scope: HTMLElement) => {
  await app.user.click(within(scope).getByRole("button", { name: "Details" }));
  return scope.querySelector("pre")?.textContent ?? "";
};

const CHECKED_AT = "2026-10-08T06:24:00.000Z";

describe("a step's status", () => {
  it("heads a done step with its state word and line, its details under Details, one Check again, and Open in Settings that says it leaves Set up", async () => {
    const app = await firstLaunch({ setup: onlySteps({ skills: { reason: "Your skills are ready.", details: ["Collections: 2"] } }) });
    const skills = await cardOf(app, "Skills");
    expect(await within(skills).findByText("Your skills are ready.")).toBeDefined();
    expect(within(skills).getByText("Done", { selector: "[data-state-word]" })).toBeDefined();
    expect(within(skills).queryByRole("alert")).toBeNull();
    expect(within(skills).getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    expect(within(skills).queryByRole("button", { name: "Check now" })).toBeNull();
    expect(await detailsIn(app, skills)).toContain("Collections: 2");

    const open = within(skills).getByRole("button", { name: "Open in Settings" });
    expect(within(skills).getByText("Leaves Set up")).toBeDefined();
    expect(open.getAttribute("aria-describedby")).toBe(within(skills).getByText("Leaves Set up").id);
    await app.user.click(open);
    expect(within(settings()).getByRole("region", { name: "Skills" })).toBeDefined();
  });

  it("says a result that needs a fix as a notice, its named actions and Check again in place, and Details with the checks that failed, when it was checked and its raw words", async () => {
    const app = await firstLaunch({ setup: onlySteps({ skills: {
      state: "needs-attention", reason: "team-skills could not update.", failing: ["skills.sources-synced"], actions: ["pull-now", "check-again"],
      targets: [{ action: "pull-now", kind: "skill-source", id: "0f8fad5b-d9cb-469f-a165-70867728950e", label: "team-skills" }],
      details: ["team-skills: fetch exited with 128"], checkedAt: CHECKED_AT,
    } }) });
    const skills = await cardOf(app, "Skills");
    const notice = await within(skills).findByRole("alert");
    expect(within(notice).getByText("team-skills could not update.")).toBeDefined();
    expect(within(skills).getByText("Needs a fix", { selector: "[data-state-word]" })).toBeDefined();
    expect(within(notice).getByRole("button", { name: "Update now: team-skills" })).toBeDefined();
    expect(within(notice).getByRole("button", { name: "Check again" })).toBeDefined();
    expect(within(skills).getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    const details = await detailsIn(app, notice);
    expect(details).toContain("Computer: desk");
    expect(details).toContain("Step: Skills (skills): Needs a fix");
    expect(details).toContain(`Checked: ${CHECKED_AT}`);
    expect(details).toContain("What we saw: team-skills could not update.");
    expect(details).toContain("Checks: skills.sources-synced");
    expect(details).toContain("team-skills: fetch exited with 128");
  });

  it("says in its label that a named action leaves Set up for Settings", async () => {
    const app = await firstLaunch({ setup: onlySteps({ forges: {
      state: "needs-attention", reason: "GitHub does not accept the saved token.", failing: ["forges.token"], actions: ["sign-in-again"],
      targets: [{ action: "sign-in-again", kind: "forge-account", id: "0199aa00-0000-7000-8000-0000000000f1", label: "GitHub" }],
    } }) });
    const forges = await cardOf(app, "Forges");
    await app.user.click(await within(forges).findByRole("button", { name: "Sign in again: GitHub (leaves Set up)" }));
    expect(within(settings()).getByRole("region", { name: "Forges" })).toBeDefined();
  });

  it("says a check that could not run as Set up opens, its refusal under Details, until Check again runs one", async () => {
    const app = await firstLaunch({}, (app) => app.environment("desk").refuseSetupChecks({ code: "internal", message: "The step registry could not load.", data: {} }));
    const skills = await cardOf(app, "Skills");
    const notice = await within(skills).findByRole("alert");
    expect(within(notice).getByText("agent-harness could not run the check.")).toBeDefined();
    expect(within(notice).getByText("Choose Check again.")).toBeDefined();
    expect(within(notice).getByText("Error:")).toBeDefined();
    expect(await detailsIn(app, notice)).toContain("internal: The step registry could not load.");

    app.environment("desk").refuseSetupChecks(null);
    await app.user.click(within(skills).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(within(skills).queryByText("agent-harness could not run the check.")).toBeNull());
    expect(app.environment("desk").requests("setup.check").at(-1)?.params).toEqual({ step: "skills" });
  });

  it("says a Check again that could not run, with its refusal under Details", async () => {
    const app = await firstLaunch({ setup: onlySteps({ skills: {} }) });
    const skills = await cardOf(app, "Skills");
    app.environment("desk").refuseSetupChecks({ code: "unavailable", message: "Draining.", data: { readiness: "draining" } });
    await app.user.click(within(skills).getByRole("button", { name: "Check again" }));
    const notice = await within(skills).findByRole("alert");
    expect(within(notice).getByText("agent-harness could not run the check.")).toBeDefined();
    expect(await detailsIn(app, notice)).toContain("unavailable (draining): Draining.");
  });

  it("says a start its result offers that did not start, with the failure under Details", async () => {
    const app = await firstLaunch({ setup: onlySteps({ skills: { state: "needs-attention", reason: "The service is stopped.", failing: ["skills.service"], actions: ["start-service"] } }) });
    app.shell.answer("service.start", async () => { throw new Error("launchctl bootstrap answered 5"); });
    const skills = await cardOf(app, "Skills");
    await app.user.click(await within(skills).findByRole("button", { name: "Start" }));
    const failed = (await within(skills).findByText("agent-harness did not start on desk.")).closest<HTMLElement>("[role=alert]") as HTMLElement;
    expect(within(failed).getByText("Choose Start to try again.")).toBeDefined();
    expect(await detailsIn(app, failed)).toContain("launchctl bootstrap answered 5");
  });

  it("says each action's outcome as a notice: a success as information, a refusal plainly as an error, and a refused tool's own command under Details", async () => {
    const app = await firstLaunch({ capabilities: ["managedTools"],
      managedTools: { runs: { gh: { refused: { message: "No supported install method.", command: "brew install gh" } } } },
      setup: onlySteps({ forges: { state: "needs-attention", reason: "gh is missing.", failing: ["forges.gh"], actions: ["install"],
        targets: [{ action: "install", kind: "tool", id: "gh", label: "gh" }],
      } }),
    });
    const forges = await cardOf(app, "Forges");
    await app.user.click(await within(forges).findByRole("button", { name: "Install gh in a tool terminal" }));
    const refused = (await within(forges).findByText("That tool cannot be installed from here.")).closest<HTMLElement>("[role=alert]") as HTMLElement;
    expect(refused.dataset["noticeTone"]).toBe("error");
    expect(within(refused).queryByText(/^Not run:/)).toBeNull();
    await app.user.click(within(refused).getByRole("button", { name: "Details" }));
    const command = within(refused).getByRole("region", { name: "Or run this yourself on desk:" });
    expect(within(command).getByText("brew install gh")).toBeDefined();
    expect(within(refused).getByText(/tool_not_runnable: No supported install method\./)).toBeDefined();
  });

  it("says a done action's outcome as information", async () => {
    const app = await firstLaunch({ setup: onlySteps({ skills: {
      state: "needs-attention", reason: "team-skills is behind.", failing: ["skills.sources-synced"], actions: ["pull-now"],
      targets: [{ action: "pull-now", kind: "skill-source", id: "0f8fad5b-d9cb-469f-a165-70867728950e", label: "team-skills" }],
    } }) });
    app.environment("desk").wire.answer("skills.sources.pull", (params) => {
      const since = app.clock.now().toISOString();
      return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { source: {
        id: params.sourceId, url: "https://git.example.test/team/skills", identity: "https://git.example.test/team/skills", folder: ".",
        follow: { kind: "branch", branch: "main" }, position: 1, addedBy: { kind: "client_session", id: "desk" }, addedAt: since,
        commit: "c".repeat(40), skillCount: 1, sync: { outcome: "ok", since }, attemptedAt: since,
      } } } };
    });
    const skills = await cardOf(app, "Skills");
    await app.user.click(await within(skills).findByRole("button", { name: "Update now: team-skills" }));
    const said = (await within(skills).findByText("team-skills is up to date.")).closest<HTMLElement>("[data-notice-tone]") as HTMLElement;
    expect(said.dataset["noticeTone"]).toBe("info");
    expect(said.getAttribute("role")).toBe("status");
  });
});

describe("the reach line", () => {
  it("offers Try again on an environment this app cannot reach, which reaches it again", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local" }, { name: "laptop", reach: "paired", capabilities: ["setup"], setup: onlySteps({}) }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await app.user.selectOptions(within(await screen.findByRole("region", { name: "Set up" })).getByRole("combobox", { name: "Environment" }), "laptop");
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(checklist()).findByText(/^This app cannot reach laptop \(since \d\d:\d\d\)\. These results may be out of date\.$/)).toBeDefined();
    laptop.discovery("ready");
    await app.user.click(within(checklist()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(checklist()).queryByText(/^This app cannot reach laptop/)).toBeNull());
  });

  it("says a Start that did not start this computer's environment, with the failure under Details", async () => {
    // With the setup flag, the results come on the environment's stream, which the runtime keeps across a restart.
    const first = await renderApp({ environments: [{ name: "desk", reach: "local", environmentId: "0199aa00-0000-7000-8000-00000000d35c", capabilities: ["setup"], setup: onlySteps({}) }] });
    await first.user.keyboard("{Control>},{/Control}");
    await waitFor(() => expect(within(settings()).queryAllByRole("img").length).toBeGreaterThan(0));
    first.environment("desk").discovery("nothing");
    const app = await first.remount();
    app.shell.answer("service.start", async () => { throw new Error("Error: the service manager refused the unit"); });
    await app.user.keyboard("{Control>},{/Control}");
    const pane = within(await screen.findByRole("region", { name: "Settings" })).getByRole("region", { name: "Set up" });
    const bar = (await within(pane).findByText("agent-harness is not running on desk. These results are from before it stopped.")).closest<HTMLElement>("[data-reach-line]") as HTMLElement;
    await app.user.click(within(bar).getByRole("button", { name: "Start" }));
    const failed = (await within(bar).findByText("agent-harness did not start on desk.")).closest<HTMLElement>("[role=alert]") as HTMLElement;
    expect(within(failed).getByText("Choose Start to try again.")).toBeDefined();
    expect(await detailsIn(app, failed)).toContain("the service manager refused the unit");
    expect(within(bar).getAllByRole("button", { name: "Start" })).toHaveLength(1);
  });
});
