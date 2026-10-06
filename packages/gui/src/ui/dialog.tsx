import { AlertDialog as RadixAlertDialog, Dialog as RadixDialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { X } from "lucide-react";
import { classes } from "./classes.js";
import { Button } from "./button.js";
import { Tooltip } from "./tooltip.js";

/** A modal named by its title; focus and dismissal remain Radix's. */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export const DIALOG_SCRIM = "fixed inset-0 z-50 bg-scrim/10 backdrop-blur-[4px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-100 motion-reduce:animate-none";
export const DIALOG_SURFACE = "phone-dialog-surface fixed left-1/2 top-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-96 -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl bg-float p-4 text-ink ring-1 ring-ink/10 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-100 motion-reduce:animate-none";
export const DIALOG_FOOTER = "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t border-hairline bg-raised/50 p-4 sm:flex-row sm:justify-end";

export type DialogContentProps = Omit<ComponentProps<typeof RadixDialog.Content>, "title"> & {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Forms protecting an in-flight operation can hide the stock close action. */
  readonly showClose?: boolean;
};

export const DialogContent = ({ title, description, showClose = true, className, children, onKeyDown, onEscapeKeyDown, ...props }: DialogContentProps) => (
  <RadixDialog.Portal>
    <RadixDialog.Overlay className={DIALOG_SCRIM} />
    <RadixDialog.Content
      {...(description === undefined && { "aria-describedby": undefined })}
      onEscapeKeyDown={(event) => {
        if (event.target instanceof Element && event.target.closest("[data-local-escape]")) event.preventDefault();
        onEscapeKeyDown?.(event);
      }}
      onKeyDown={(event) => { onKeyDown?.(event); event.stopPropagation(); }}
      className={classes(DIALOG_SURFACE, className)}
      {...props}
    >
      <div className={classes("flex flex-col gap-1.5", showClose && "pr-6")}>
        <RadixDialog.Title className="text-base font-medium">{title}</RadixDialog.Title>
        {description !== undefined && <RadixDialog.Description className="text-sm text-ink-muted">{description}</RadixDialog.Description>}
      </div>
      {children}
      {showClose && <Tooltip content="Close dialog" keys="Escape"><RadixDialog.Close asChild><Button aria-label="Close dialog" size="icon-xs" className="absolute top-2 right-2"><X aria-hidden="true" /></Button></RadixDialog.Close></Tooltip>}
    </RadixDialog.Content>
  </RadixDialog.Portal>
);

export const DialogFooter = ({ className, ...props }: ComponentProps<"div">) => <div className={classes(DIALOG_FOOTER, className)} {...props} />;

/** A confirmation requires an explicit action or cancellation; outside presses never accept it. */
export const AlertDialog = RadixAlertDialog.Root;
export const AlertDialogTrigger = RadixAlertDialog.Trigger;
export const AlertDialogAction = RadixAlertDialog.Action;
export const AlertDialogCancel = RadixAlertDialog.Cancel;
export const AlertDialogContent = ({ title, description, className, children, size = "default", onKeyDown, ...props }: Omit<ComponentProps<typeof RadixAlertDialog.Content>, "title"> & { readonly title: ReactNode; readonly description: ReactNode; readonly size?: "default" | "sm" }) => (
  <RadixAlertDialog.Portal>
    <RadixAlertDialog.Overlay className={DIALOG_SCRIM} />
    <RadixAlertDialog.Content onKeyDown={(event) => { onKeyDown?.(event); event.stopPropagation(); }} className={classes(DIALOG_SURFACE, "max-w-80 sm:max-w-96", size === "sm" && "sm:max-w-80", className)} {...props}>
      <div className="flex flex-col gap-1.5"><RadixAlertDialog.Title className="text-base font-medium">{title}</RadixAlertDialog.Title><RadixAlertDialog.Description className="text-sm text-ink-muted">{description}</RadixAlertDialog.Description></div>
      {children}
    </RadixAlertDialog.Content>
  </RadixAlertDialog.Portal>
);
export const AlertDialogFooter = DialogFooter;
export const AlertDialogMedia = ({ className, ...props }: ComponentProps<"div">) => <div className={classes("mb-2 flex size-10 items-center justify-center rounded-md bg-raised [&_svg]:size-6", className)} {...props} />;
