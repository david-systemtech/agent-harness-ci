import type { DocumentKind, SessionDocument } from "@agent-harness/client-runtime";

/**
 * How the terminal UI opens a session's document (docs/specs/tui.md, "The
 * parity contract in practice"; #427): `/documents` lists
 * `projections.documents`, the pages, SVGs and markdown the session wrote,
 * and Enter opens one. Pure.
 *
 * - **Markdown** is text: the pager reads it through `files.read`, as
 *   `/files` reads a file, with the pager's search and its copy.
 * - **A page or an SVG** is drawn by the desktop window's preview alone,
 *   which frames it sandboxed: Enter says so in one line with the file's
 *   path and reads nothing, so no markup reaches the terminal.
 */

/** Where each kind opens: the pager, or the desktop window's preview with the noun the line calls it by. */
const OPENS_IN: Readonly<Record<DocumentKind, { readonly in: "pager" } | { readonly in: "preview"; readonly noun: string }>> = {
  markdown: { in: "pager" },
  page: { in: "preview", noun: "page" },
  svg: { in: "preview", noun: "SVG" },
};

/**
 * What Enter says of `document` in place of reading it: that the desktop
 * window's preview draws it, and its path under `workspace` (the path alone
 * while the workspace is not known); null for a document the pager reads.
 */
export const previewLine = (document: SessionDocument, workspace: string | null): string | null => {
  const opens = OPENS_IN[document.kind];
  if (opens.in === "pager") return null;
  const path = workspace === null || workspace === "" ? document.path : `${workspace.replace(/\/+$/, "")}/${document.path}`;
  return `The desktop window's preview draws this ${opens.noun}, not the terminal: ${path}`;
};
