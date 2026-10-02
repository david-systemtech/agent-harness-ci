import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRESENTATION_FILE, inMemoryPresentation, presentationFile } from "./presentation.js";

/**
 * The terminal UI's client-local presentation (ADR 0003; glossary: Pane):
 * the rail's fold state per heading name, the one presentation key
 * `collapsedHeadings`, kept in the state directory so a fold outlives a
 * launch. Nothing about a session is kept here.
 */

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const stateDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-harness-presentation-"));
  dirs.push(dir);
  return dir;
};

describe("collapsedHeadings", () => {
  it("holds a fold per heading name and tells its followers", () => {
    const presentation = inMemoryPresentation();
    const seen: unknown[] = [];
    presentation.collapsedHeadings.subscribe((value) => seen.push(value));
    presentation.setFolded("group:meadowstudios", true);
    presentation.setFolded("shelf:settled", false);
    expect(presentation.collapsedHeadings.read()).toEqual({ "group:meadowstudios": true, "shelf:settled": false });
    expect(seen).toHaveLength(2);
  });

  it("is written whole to the state directory under its one key, and read back at the next launch", () => {
    const dir = stateDir();
    presentationFile(dir).setFolded("group:meadowstudios", true);
    expect(JSON.parse(readFileSync(join(dir, PRESENTATION_FILE), "utf8"))).toEqual({ format: 1, collapsedHeadings: { "group:meadowstudios": true } });
    expect(presentationFile(dir).collapsedHeadings.read()).toEqual({ "group:meadowstudios": true });
  });

  it("drops the folds a keep refuses as it writes the document, so a gone group's fold does not stay behind", () => {
    const dir = stateDir();
    const presentation = presentationFile(dir);
    presentation.setFolded("group:gone", true);
    presentation.setFolded("group:kept", true);
    const present = (heading: string) => !heading.startsWith("group:") || heading === "group:kept";
    presentation.setFolded("shelf:settled", false, present);
    expect(JSON.parse(readFileSync(join(dir, PRESENTATION_FILE), "utf8"))).toEqual({ format: 1, collapsedHeadings: { "group:kept": true, "shelf:settled": false } });
    // A fold that changes nothing still writes the document when it drops one.
    presentation.setFolded("group:other", true);
    presentation.setFolded("shelf:settled", false, present);
    expect(presentation.collapsedHeadings.read()).toEqual({ "group:kept": true, "shelf:settled": false });
  });

  it("starts empty from a file it cannot read, reports it once, and never writes over it until a fold changes", () => {
    const dir = stateDir();
    writeFileSync(join(dir, PRESENTATION_FILE), "{ not json");
    const reported: unknown[] = [];
    const presentation = presentationFile(dir, (error) => reported.push(error));
    expect(presentation.collapsedHeadings.read()).toEqual({});
    expect(reported).toHaveLength(1);
    expect(readFileSync(join(dir, PRESENTATION_FILE), "utf8")).toBe("{ not json");
  });
});
