import { DialogContent, type DialogContentProps } from "../ui/dialog.js";

/** Announce the sheet before focusing an action whose tooltip could cover its title. */
export const PhoneComposerSheet = (props: Omit<DialogContentProps, "className" | "onOpenAutoFocus">) => <DialogContent
  {...props}
  className="phone-composer-sheet top-auto translate-y-0"
  onOpenAutoFocus={event => {
    event.preventDefault();
    if (event.target instanceof HTMLElement) event.target.focus();
  }}
/>;
