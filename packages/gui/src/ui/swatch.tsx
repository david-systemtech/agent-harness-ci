import type { TokenName } from "@agent-harness/theme";
import { cn } from "./classes.js";
/** A named theme token, never a literal colour. */
export const Swatch = ({ token, label, className }: { readonly token: TokenName; readonly label: string; readonly className?: string }) => <span role="img" aria-label={label} title={label} className={cn("inline-block size-5 rounded-sm border border-hairline-strong", className)} style={{ backgroundColor: `var(--${token})` }} />;
