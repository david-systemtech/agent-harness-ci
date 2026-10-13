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
    const first = coordinator.exclusive({ importId: "import-1", dryRun: false, kind: "state-import" }, (applying) => {
      enterApplying = applying;
      return gate.promise;
    });
    expect(coordinator.state()).toEqual({ importId: "import-1", dryRun: false, kind: "state-import", phase: "preparing" });
    expect(coordinator.exclusive({ importId: "preview-1", dryRun: true, kind: "state-import" }, async () => "preview")).toBeNull();
    enterApplying();
    expect(coordinator.state()).toEqual({ importId: "import-1", dryRun: false, kind: "state-import", phase: "applying" });
    expect(coordinator.underWay()).toEqual(coordinator.state());
    expect(coordinator.exclusive({ importId: "import-2", dryRun: false, kind: "state-import" }, async () => "second")).toBeNull();

    gate.resolve("report");
    expect(await first).toBe("report");
    expect(coordinator.state()).toEqual({ importId: "import-1", dryRun: false, kind: "state-import", phase: "finished" });
    expect(coordinator.underWay()).toBeNull();
    expect(await coordinator.exclusive({ importId: "preview-2", dryRun: true, kind: "state-import" }, async () => "preview")).toBe("preview");
  });

  it("holds the environment for a dry run too, and releases it when the work fails, thrown at once or later", async () => {
    const coordinator = createImportCoordinator();
    const gate = held();
    const preview = coordinator.exclusive({ importId: "preview-1", dryRun: true, kind: "state-import" }, () => gate.promise);
    expect(coordinator.exclusive({ importId: "import-1", dryRun: false, kind: "state-import" }, async () => "import")).toBeNull();
    gate.reject(new Error("The source folder went away."));
    await expect(preview).rejects.toThrow("The source folder went away.");
    expect(coordinator.state()).toEqual({ importId: "preview-1", dryRun: true, kind: "state-import", phase: "failed" });

    const thrown = coordinator.exclusive({ importId: "import-2", dryRun: false, kind: "state-import" }, () => {
      throw new Error("Refused before preparing.");
    });
    await expect(thrown).rejects.toThrow("Refused before preparing.");
    expect(coordinator.state()).toMatchObject({ importId: "import-2", phase: "failed" });
    expect(await coordinator.exclusive({ importId: "import-3", dryRun: false, kind: "state-import" }, async () => "import")).toBe("import");
  });

  it("holds the environment for one account's Carry over as its own kind, refusing a state import meanwhile (#2098)", async () => {
    const coordinator = createImportCoordinator();
    const gate = held();
    const carry = coordinator.exclusive({ importId: "carry-1", dryRun: false, kind: "carry-over" }, () => gate.promise);
    expect(coordinator.underWay()).toEqual({ importId: "carry-1", dryRun: false, kind: "carry-over", phase: "preparing" });
    expect(coordinator.exclusive({ importId: "import-1", dryRun: false, kind: "state-import" }, async () => "import")).toBeNull();
    gate.resolve("report");
    expect(await carry).toBe("report");
    expect(coordinator.underWay()).toBeNull();
  });
});
