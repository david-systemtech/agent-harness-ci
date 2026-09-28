import { z } from "zod";

/**
 * An environment's colour (workspace-picker spec, "Name, icon and colour"):
 * one of twelve names, never a literal. The theme package derives a light
 * and a dark token for each within its contrast rules (ADR 0023), and the
 * terminal UI maps each onto one of the terminal's own colours.
 */
export const ENVIRONMENT_COLOURS = ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"] as const;
export const EnvironmentColour = z.enum(ENVIRONMENT_COLOURS).meta({
  description:
    "An environment's colour, by name: red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, violet or pink. Never a literal: each client draws it with the theme's token for the name.",
});
export type EnvironmentColour = z.infer<typeof EnvironmentColour>;
