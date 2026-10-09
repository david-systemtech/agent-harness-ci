import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../.forgejo/github-workflows/ci.yml"), "utf8");
const job = (name: string): string => {
  const body = workflow.split(`\n  ${name}:\n`)[1];
  if (body === undefined) throw new Error(`missing hosted CI job: ${name}`);
  return body.split(/\n {2}[a-z-]+:\n/)[0] ?? "";
};

describe("the hosted CI workflow", () => {
  it.each(["checks", "root-user"])("initializes %s without Docker Hub's anonymous pull quota", (name) => {
    // The official mirror retains the Node and Debian versions required by the checks.
    expect(job(name)).toMatch(/^ {4}container: public\.ecr\.aws\/docker\/library\/node:24-bookworm$/m);
    expect(job(name)).not.toContain("continue-on-error");
  });

  it("retains every required check and checks out the dispatched commit", () => {
    const checks = job("checks");
    expect(checks).toContain('"$w/gitleaks" git --no-banner --redact --exit-code 1 --log-opts="HEAD" .');
    for (const command of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm lint", "pnpm --filter @agent-harness/contracts export-schemas"]) {
      expect(checks).toContain(command);
    }
    expect(checks).toContain('git status --porcelain -- packages/contracts/schema');
    expect(checks).toContain("exit 1");
    for (const name of ["checks", "test", "root-user"]) {
      expect(job(name)).toContain("ref: ${{ github.event.client_payload.sha }}");
      expect(job(name)).not.toContain("continue-on-error");
      expect(job(name)).not.toMatch(/^ {4}if:/m);
    }
  });

  it("keeps the ordinary-user shards and the fail-closed root-only gate", () => {
    const suite = job("test");
    expect(suite).not.toMatch(/^ {4}container:/m);
    expect(suite).toContain("shard: [1, 2, 3, 4, 5, 6]");
    expect(suite).toContain('[ "$(id -u)" != 0 ] ||');
    expect(suite).toContain("pnpm test --maxWorkers=4 --shard=${{ matrix.shard }}/6");
    const root = job("root-user");
    expect(root).toContain("set -euo pipefail");
    expect(root).toContain('[ "$(id -u)" = 0 ] ||');
    expect(root).toContain("git grep -lE 'process\\.gete?uid' -- '*.test.ts' '*.test.tsx'");
    expect(root).toContain('[ "${#files[@]}" -gt 0 ] ||');
    expect(root).toContain('pnpm exec vitest run --maxWorkers=4 "${files[@]}"');
  });

  it("cleans up only after all checks and test jobs finish, even on failure", () => {
    expect(job("cleanup")).toContain("needs: [checks, test, root-user]");
    expect(job("cleanup")).toContain("if: always()");
    expect(job("cleanup")).toContain('git/refs/heads/$RUN_REF');
  });
});
