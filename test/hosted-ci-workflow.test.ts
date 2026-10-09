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
  it.each([
    ["ci.yml", "checks"],
    ["ci.yml", "root-user"],
    ["catalogue.yml", "catalogue"],
  ])("%s's %s obtains Node 24 and Bookworm without Docker Hub credentials or quota", (file, name) => {
    const job = jobs(file).get(name);
    expect(job).toContain("    container: public.ecr.aws/docker/library/node:24-bookworm\n");
    expect(job).not.toMatch(/^ +credentials:/m);
  });

  it("keeps every hosted job container off Docker Hub", () => {
    for (const file of readdirSync(workflows).filter((name) => name.endsWith(".yml"))) {
      const workflow = readFileSync(join(workflows, file), "utf8");
      for (const container of workflow.matchAll(/^ {4}container:(.*)$/gm)) {
        expect(container[1]?.trim(), file).toMatch(/^public\.ecr\.aws\//);
      }
    }
  });
});
