import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/index.js";
import { TechnicalDetails, type TechnicalDetailsProps } from "./details.js";

export type NoticeTone = "info" | "warning" | "error";

const TONES: { readonly [Tone in NoticeTone]: { readonly Icon: LucideIcon; readonly variant: "default" | "warning" | "destructive"; readonly role: "status" | "alert" } } = {
  info: { Icon: Info, variant: "default", role: "status" },
  warning: { Icon: TriangleAlert, variant: "warning", role: "alert" },
  error: { Icon: CircleAlert, variant: "destructive", role: "alert" },
};

export interface SetupNoticeProps {
  /** Error only when the person must act (setup-copy.md §1 rule 14). */
  readonly tone: NoticeTone;
  /** What happened, in 3 to 6 words. */
  readonly title: string;
  /** One more sentence: why it matters, or the one thing to do next. */
  readonly description?: string;
  /** The buttons that do the next thing, named by what they do. */
  readonly actions?: ReactNode;
  /** A fold of the card's own beneath the buttons, such as how to fix it outside agent-harness. */
  readonly fold?: ReactNode;
  /** The technical facts behind Details, with Copy details. */
  readonly details?: TechnicalDetailsProps;
}

/**
 * A notice on a Set up card (setup-copy.md §1 rules 3, 14 and 15; look.md
 * §5.3's Alert): its icon, its title and a sentence, the buttons in place and
 * Details. A warning or an error is an alert, an error read with a hidden
 * "Error: " first; information is a status. Everything it says is visible text.
 */
export const SetupNotice = ({ tone, title, description, actions, fold, details }: SetupNoticeProps) => {
  const { Icon, variant, role } = TONES[tone];
  return (
    <Alert role={role} variant={variant} data-notice-tone={tone}>
      <Icon aria-hidden="true" />
      <AlertTitle>{tone === "error" && <><span className="sr-only">Error:</span>{" "}</>}{title}</AlertTitle>
      {description !== undefined && <AlertDescription>{description}</AlertDescription>}
      {actions !== undefined && <div className="col-start-2 mt-1.5 flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      {fold !== undefined && <div className="col-start-2 mt-1 min-w-0 text-ink">{fold}</div>}
      {details !== undefined && <div className="col-start-2 mt-1 min-w-0 text-ink"><TechnicalDetails {...details} /></div>}
    </Alert>
  );
};
