import { Plus, Trash2, X } from "lucide-react";
import { Button } from "../../src/ui/button.js";
import { Input } from "../../src/ui/input.js";
import { Field } from "../../src/ui/field.js";
import { Tooltip, TooltipProvider } from "../../src/ui/tooltip.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogMedia, Dialog, DialogClose, DialogContent, DialogFooter } from "../../src/ui/dialog.js";

/** Two fixed examples keep the standard and explicit-confirmation anatomy visible in each ladder. */
export const DialogsScene = () => <TooltipProvider><main data-scene="dialogs" className="min-h-screen bg-abyss p-6 text-sm text-ink">
  <h1 className="text-lg font-medium">Dialogs and confirmations</h1>
  <p className="mt-2 text-ink-muted">The window stays visible behind the scrim.</p>
  <Dialog open modal={false}>
    <DialogContent title="New session" description="Choose a name for this session." className="left-[30%] z-[51]" onOpenAutoFocus={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()} data-geometry="dialog">
      <Field label="Session name"><Input data-geometry="dialog-name" defaultValue="Build notes" /></Field>
      <DialogFooter><Tooltip content="Cancel · Escape"><DialogClose asChild><Button variant="outline"><X aria-hidden="true" />Cancel</Button></DialogClose></Tooltip><Tooltip content="Create session · Enter"><Button variant="default"><Plus aria-hidden="true" />Create session</Button></Tooltip></DialogFooter>
    </DialogContent>
  </Dialog>
  <AlertDialog open>
    <AlertDialogContent title="Delete this session?" description="You can restore it for thirty days." className="left-[70%] z-[51]" data-geometry="confirmation" onOpenAutoFocus={(event) => event.preventDefault()}>
      <AlertDialogMedia><Trash2 aria-hidden="true" /></AlertDialogMedia>
      <AlertDialogFooter><Tooltip content="Cancel · Escape"><AlertDialogCancel asChild><Button variant="outline"><X aria-hidden="true" />Cancel</Button></AlertDialogCancel></Tooltip><Tooltip content="Delete session · Enter"><AlertDialogAction asChild><Button variant="destructive"><Trash2 aria-hidden="true" />Delete session</Button></AlertDialogAction></Tooltip></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</main></TooltipProvider>;
export const geometry = [
  { selector: '[data-geometry="dialog"]', width: 384, tolerance: 0.1 },
  { selector: '[data-geometry="confirmation"]', width: 384, tolerance: 0.1 },
  { selector: '[data-geometry="dialog-name"]', height: 32, tolerance: 0.1 },
];
export default DialogsScene;
