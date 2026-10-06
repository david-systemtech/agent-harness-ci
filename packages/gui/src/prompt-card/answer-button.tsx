import { Check, X } from "lucide-react";
import { Kbd } from "../ui/kbd.js";
import { Tooltip as UiTooltip } from "../ui/tooltip.js";
import { createContext, useContext, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../ui/index.js";

/** A prompt tooltip dismisses and denies together, preserving the card's Escape action. */
export const PromptEscape = createContext<(() => void) | undefined>(undefined);
export const PromptTooltip = (props: ComponentProps<typeof UiTooltip>) => {
  const deny = useContext(PromptEscape);
  return <UiTooltip {...props} onEscapeKeyDown={deny === undefined ? undefined : () => deny()} />;
};

export interface AnswerProps {
  /** The connection cannot answer now: drawn dim, and a press says why. */
  readonly dim: boolean;
  /** It approves: a bare Enter never presses it, even with the focus on it. */
  readonly approves?: boolean;
  /** A mode above the ceiling: greyed, and a press says why. */
  readonly greyed?: boolean;
  readonly keys?: string | undefined;
  readonly hint?: string | undefined;
  readonly describedBy?: string | undefined;
  /** Full action name when a narrow surface uses shorter visible wording. */
  readonly label?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

/** A bare Enter, which never approves. */
const bareEnter = (event: KeyboardEvent) => event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

/**
 * One answer's button, on a parked prompt's card and in the Parked asks
 * view. Dim or greyed is `aria-disabled`, not `disabled`, so it still takes
 * the pointer and the focus, and a press says why nothing is sent. An
 * approving one refuses a bare Enter, which a button would otherwise take as
 * a click, so nothing is approved by reflex (story 10).
 */
export const Answer = ({ dim, approves = false, greyed = false, describedBy, keys, hint, label, onClick, children }: AnswerProps) => {
  const Icon = approves ? Check : X;
  return <PromptTooltip content={[children, keys ?? (approves ? "Space" : "Enter or Space"), hint].filter(Boolean).join(" · ")}>
    <Button
      size="sm"
      aria-label={label ?? (typeof children === "string" ? children : undefined)}
      variant={approves && !greyed ? "default" : "ghost"}
      aria-disabled={dim || greyed ? true : undefined}
      aria-describedby={describedBy}
      className="border border-line aria-disabled:cursor-default aria-disabled:border-hairline aria-disabled:bg-transparent aria-disabled:text-ink-faint"
      onKeyDown={(event) => {
        if (approves && bareEnter(event)) event.preventDefault();
      }}
      onClick={onClick}
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      {children}
      {keys !== undefined && <Kbd aria-hidden="true">{keys}</Kbd>}
    </Button>
  </PromptTooltip>;
};
