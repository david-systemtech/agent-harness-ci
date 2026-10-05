import { Dialog } from "radix-ui";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { KeyContext } from "../keys/key-dispatch.js";
import { Button } from "../ui/index.js";
import { PromptEscape } from "./answer-button.js";

/** The portal inherits the web frame's single keyboard/safe-area bounds. */
export const PhonePromptDetails = ({ open, onOpenChange, title, restore, footer, keys, children }: {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  readonly title: string;
  readonly restore: RefObject<HTMLElement | null>;
  readonly footer: ReactNode;
  readonly keys: ReactNode;
  readonly children: ReactNode;
}) => {
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const frame = anchor?.closest<HTMLElement>("[data-web-client]");
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <span hidden ref={setAnchor} />
    <Dialog.Portal container={frame ?? undefined}>
      <Dialog.Overlay className="phone-prompt-scrim bg-scrim/30" />
      <Dialog.Content ref={content} className="phone-prompt-sheet rounded-xl border border-hairline bg-float text-ink outline-none" aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); content.current?.focus({ preventScroll: true }); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const summary = restore.current;
          const target = summary?.isConnected ? summary.querySelector<HTMLElement>("button") : frame?.querySelector<HTMLElement>('[aria-label="Message"]');
          target?.focus({ preventScroll: true });
        }}
        onKeyDown={event => event.stopPropagation()}>
        <KeyContext context="permission">{keys}<PromptEscape value={() => onOpenChange(false)}>
          <header className="flex shrink-0 items-center justify-between gap-2">
            <Dialog.Title className="min-w-0 font-medium">{title}</Dialog.Title>
            <Dialog.Close asChild><Button size="sm">Close</Button></Dialog.Close>
          </header>
          <div data-phone-prompt-body className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
          <footer data-phone-prompt-answer className="shrink-0 border-t border-hairline pt-2">{footer}</footer>
        </PromptEscape></KeyContext>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
};
