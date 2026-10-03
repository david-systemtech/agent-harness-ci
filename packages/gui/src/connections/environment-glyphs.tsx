import { ENVIRONMENT_ICONS, type EnvironmentIcon } from "@agent-harness/contracts";
import { Box, Building, Cloud, Cpu, Database, FlaskConical, House, Laptop, Monitor, Server, type LucideIcon } from "lucide-react";

/** ADR 0025's fixed names, drawn on the shared 24-unit, two-stroke icon grid. */
const GLYPHS: Readonly<Record<EnvironmentIcon, LucideIcon>> = {
  laptop: Laptop, desktop: Monitor, server: Server, nas: Database, cloud: Cloud,
  container: Box, board: Cpu, home: House, office: Building, lab: FlaskConical,
};

/** Unknown names keep the unlabelled-dot fallback used by older and newer environments. */
export const glyphOf = (icon: string | null): { readonly icon: EnvironmentIcon; readonly Icon: LucideIcon } | undefined => {
  const known = ENVIRONMENT_ICONS.find((name) => name === icon);
  return known === undefined ? undefined : { icon: known, Icon: GLYPHS[known] };
};
