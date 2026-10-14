import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflows = join(import.meta.dirname, "../.forgejo/github-workflows");
const jobs = (file: string) => {
  const workflow = readFileSync(join(workflows, file), "utf8");
  return new Map([...workflow.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:|$(?![\s\S]))/gm)]
    .map((match) => [match[1], match[2]]));
};

describe("hosted Node job containers", () => {
  it("runs checks on hosted Ubuntu with Node 24 instead of pulling a rate-limited job image", () => {
    const job = jobs("ci.yml").get("checks");
    expect(job).toContain("    runs-on: ubuntu-24.04\n");
    expect(job).not.toMatch(/^ +container:/m);
    expect(job).toMatch(/uses: actions\/setup-node@[a-f0-9]{40}[^\n]*\n(?: +[^\n]+\n)*? +node-version: 24\n/);
    expect(job).not.toContain("safe.directory");
    expect(job).toContain("run: pnpm typecheck");
    expect(job).toContain("run: pnpm lint");
    expect(job).toContain("export-schemas");
    expect(job).toContain("gitleaks");
  });

  it("retries a failed Node setup after 30 seconds and lets the final attempt fail the job", () => {
    const steps = jobs("ci.yml").get("checks")?.split("      - ") ?? [];
    const attempts = steps.filter((step) => step.includes("uses: actions/setup-node@"));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain("id: node");
    expect(attempts[0]).toContain("continue-on-error: true");
    expect(attempts[0]).toContain("node-version: 24");
    const retryCondition = "if: ${{ steps.node.outcome == 'failure' }}";
    const backoff = steps.find((step) => step.includes("run: sleep 30"));
    expect(backoff).toContain(retryCondition);
    expect(steps.indexOf(backoff ?? "")).toBeGreaterThan(steps.indexOf(attempts[0] ?? ""));
    expect(steps.indexOf(backoff ?? "")).toBeLessThan(steps.indexOf(attempts[1] ?? ""));
    expect(attempts[1]).toContain(retryCondition);
    expect(attempts[1]).toContain("node-version: 24");
    expect(attempts[1]).not.toContain("continue-on-error");
    expect(attempts[1]?.match(/uses: ([^\n]+)/)?.[1]).toBe(attempts[0]?.match(/uses: ([^\n]+)/)?.[1]);
    expect(steps.indexOf(attempts[1] ?? "")).toBeLessThan(steps.findIndex((step) => step.includes("run: corepack enable")));
  });

  it.each([
    ["ci.yml", "root-user"],
    ["catalogue.yml", "catalogue"],
  ])("%s's %s obtains Node 24 and Bookworm, as root, without registry credentials or quota", (file, name) => {
    const job = jobs(file).get(name);
    expect(job).toContain("    container:\n      image: mcr.microsoft.com/devcontainers/javascript-node:24-bookworm\n      options: --user root\n");
    expect(job).not.toMatch(/^ +credentials:/m);
  });

  it("keeps every hosted job container off Docker Hub and ECR Public's anonymous quotas", () => {
    for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
      const workflow = readFileSync(join(workflows, file), "utf8");
      expect(workflow, file).not.toMatch(/^ {4}container: /m);
      for (const image of workflow.matchAll(/^ {4}container:\n {6}image:(.*)$/gm)) {
        expect(image[1]?.trim(), file).toMatch(/^mcr\.microsoft\.com\//);
      }
    }
  });
});
