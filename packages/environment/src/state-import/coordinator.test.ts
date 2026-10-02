import { describe, expect, it } from "vitest";
import { createImportCoordinator } from "./coordinator.js";

/**
 * The state import's coordinator (switch-over spec, "Preview, application
 * and re-run"; #1165): one per environment, which an import and a dry run
 * alike hold from preparing through applying, and release as they finish or
 * fail, whatever way they end.
 */

/** A promise and its settlers, so a test holds an import part way. */
const held = () => {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("the import coordinator", () => {
  it("holds the environment for one import from preparing through applying, refusing a dry run meanwhile, and releases it as it finishes", async () => {
    const coordinator = createImportCoordinator();
    expect(coordinator.state()).toBeNull();
    const gate = held();
    let enterApplying!: () => void;
    const first = coordinator.exclusive("import-1", false, (applying) => {
      enterApplying = applying;
      return gate.promise;
    });
    expect(coordinator.state()).toEqual({ importId: "import-1", dryRun: false, phase: "preparing" });
    expect(coordinator.exclusive("preview-1", true, async () => "preview")).toBeNull();
    enterApplying();
    expect(coordinator.state()).toEqual({ importId: "import-1", dryRun: false, phase: "applying" });
    expect(coordinator.exclusive("import-2", false, async () => "second")).toBeNull();

    gate.resolve("report");
    expect(await first).toBe("report");
    expect(coordinator.state()).toEqual({ importId: "import-1", dryRun: false, phase: "finished" });
    expect(await coordinator.exclusive("preview-2", true, async () => "preview")).toBe("preview");
  });

  it("holds the environment for a dry run too, and releases it when the work fails, thrown at once or later", async () => {
    const coordinator = createImportCoordinator();
    const gate = held();
    const preview = coordinator.exclusive("preview-1", true, () => gate.promise);
    expect(coordinator.exclusive("import-1", false, async () => "import")).toBeNull();
    gate.reject(new Error("The source folder went away."));
    await expect(preview).rejects.toThrow("The source folder went away.");
    expect(coordinator.state()).toEqual({ importId: "preview-1", dryRun: true, phase: "failed" });

    const thrown = coordinator.exclusive("import-2", false, () => {
      throw new Error("Refused before preparing.");
    });
    await expect(thrown).rejects.toThrow("Refused before preparing.");
    expect(coordinator.state()).toMatchObject({ importId: "import-2", phase: "failed" });
    expect(await coordinator.exclusive("import-3", false, async () => "import")).toBe("import");
  });
});
