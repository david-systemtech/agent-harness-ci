/**
 * The preview frame's own colours (ADR 0023; docs/specs/gui.md, "Theme:
 * tokens, the setting and the lint"): the one place the Preview pane writes
 * a literal colour, which the literal-colour lint allowlists by this
 * module's name. A page or an SVG a run wrote is its own document, drawn in
 * its own colours and not the window's theme; what it does not paint
 * stands on white, as a browser draws a page that sets no background, so a
 * page written for a browser reads as it would there whatever the window's
 * theme.
 */
export const PREVIEW_FRAME_CANVAS = "#ffffff";
