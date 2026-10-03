import { Command as Cmdk } from "cmdk";
import { Search } from "lucide-react";
import type { ComponentProps } from "react";
import { classes } from "./classes.js";
import { Dialog, DialogContent } from "./dialog.js";

/** Presentation only: action ordering, search pages and capability gates stay with the caller. */
export const Command = ({ className, label = "Search commands", ...props }: ComponentProps<typeof Cmdk>) => <Cmdk label={label} className={classes("flex w-full flex-col overflow-hidden rounded-xl bg-float text-ink", className)} {...props} />;
export const CommandDialog = ({ children, title = "Command palette", ...props }: ComponentProps<typeof Dialog> & { readonly title?: string }) => <Dialog {...props}><DialogContent title={title} showClose={false} className="top-1/3 -translate-y-0 gap-0 overflow-hidden p-0 [&>div:first-child]:sr-only"><Command>{children}</Command></DialogContent></Dialog>;
export const CommandInput = ({ className, ...props }: ComponentProps<typeof Cmdk.Input>) => <div className="p-1"><div data-command-input="" className="flex h-8 items-center gap-2 rounded-lg border border-hairline-strong bg-hairline-strong/30 px-2"><Search aria-hidden="true" className="size-4 shrink-0 text-ink-muted" /><Cmdk.Input className={classes("h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted", className)} {...props} /></div></div>;
export const CommandList = ({ className, ...props }: ComponentProps<typeof Cmdk.List>) => <Cmdk.List className={classes("max-h-88 overflow-x-hidden overflow-y-auto p-1", className)} {...props} />;
export const CommandEmpty = ({ className, ...props }: ComponentProps<typeof Cmdk.Empty>) => <Cmdk.Empty className={classes("py-6 text-center text-sm text-ink-muted", className)} {...props} />;
export const CommandGroup = ({ className, ...props }: ComponentProps<typeof Cmdk.Group>) => <Cmdk.Group className={classes("[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-muted", className)} {...props} />;
export const CommandItem = ({ className, ...props }: ComponentProps<typeof Cmdk.Item>) => <Cmdk.Item className={classes("flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-wash-strong data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0", className)} {...props} />;
export const CommandSeparator = ({ className, ...props }: ComponentProps<typeof Cmdk.Separator>) => <Cmdk.Separator className={classes("my-1 h-px bg-hairline", className)} {...props} />;
export const CommandShortcut = ({ className, ...props }: ComponentProps<"kbd">) => <kbd className={classes("ml-auto text-xs text-ink-muted", className)} {...props} />;
