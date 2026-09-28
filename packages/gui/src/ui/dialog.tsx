import * as RadixDialog from "@radix-ui/react-dialog";
import type { ComponentProps, ReactNode } from "react";
import { classes } from "./classes.js";

/** A modal dialog: `Dialog` holds a `DialogTrigger` and a `DialogContent`, which is named by its title. */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export type DialogContentProps = Omit<ComponentProps<typeof RadixDialog.Content>, "title"> & {
  /** What names the dialog. */
  readonly title: ReactNode;
  /** A line under the title that describes it, when it needs one. */
  readonly description?: ReactNode;
};

export const DialogContent = ({ title, description, className, children, ...props }: DialogContentProps) => (
  <RadixDialog.Portal>
    <RadixDialog.Overlay className="fixed inset-0 z-40 bg-wash-strong" />
    <RadixDialog.Content
      {...(description === undefined && { "aria-describedby": undefined })}
      className={classes(
        "fixed left-1/2 top-1/2 z-50 flex w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-line-strong bg-float p-5 text-ink outline-none",
        className,
      )}
      {...props}
    >
      <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
      {description !== undefined && <RadixDialog.Description className="text-sm text-ink-muted">{description}</RadixDialog.Description>}
      {children}
    </RadixDialog.Content>
  </RadixDialog.Portal>
);
