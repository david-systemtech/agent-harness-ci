import { Dialog } from "radix-ui";
import { List, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button.js";
import "./phone-settings.css";

/** The phone layout starts where a Settings rail would leave too little room for its pane. */
export const usePhoneSettings = () => {
  const [phone, setPhone] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const resized = () => setPhone(window.innerWidth < 640);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  return phone;
};

/** Nested modal navigation traps focus, dismisses on Escape, and returns focus to its trigger. */
export const PhoneNavigation = ({ title, open, onOpenChange, children }: { readonly title: string; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly children: ReactNode }) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger asChild><Button title={`${title} · Enter`} aria-label={title} className="phone-navigation-trigger"><List aria-hidden="true" />{title}</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[60] bg-scrim" />
      <Dialog.Content data-phone-navigation aria-describedby={undefined} className="fixed inset-y-0 left-0 z-[61] flex w-[min(320px,100vw)] flex-col border-r border-hairline bg-float text-ink shadow-lg outline-none">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline p-3">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Close asChild><Button size="icon" title={`Close ${title} · Escape`} aria-label={`Close ${title}`}><X aria-hidden="true" /></Button></Dialog.Close>
        </header>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);
