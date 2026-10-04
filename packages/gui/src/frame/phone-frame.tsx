import { Dialog } from "radix-ui";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { Sidebar } from "../sidebar/sidebar.js";
import "./phone-frame.css";

interface PhoneFrame {
  readonly narrow: boolean;
  readonly drawerShown: boolean;
  showDrawer(shown: boolean): void;
}
const PhoneContext = createContext<PhoneFrame>({ narrow: false, drawerShown: false, showDrawer: () => undefined });
export const usePhoneFrame = () => use(PhoneContext);

/** Width changes only the projection; desktop sidebar preferences and pane sizes stay held. */
export const PhoneFrameProvider = ({ children }: { readonly children: ReactNode }) => {
  const [media] = useState(() => window.matchMedia("(width < 640px)"));
  const [narrow, setNarrow] = useState(media.matches);
  const [drawerShown, showDrawer] = useState(false);
  useEffect(() => {
    const changed = () => { setNarrow(media.matches); if (!media.matches) showDrawer(false); };
    media.addEventListener("change", changed);
    changed();
    return () => media.removeEventListener("change", changed);
  }, [media]);
  const value = useMemo(() => ({ narrow, drawerShown, showDrawer }), [narrow, drawerShown]);
  return <PhoneContext value={value}><Dialog.Root open={narrow && drawerShown} onOpenChange={showDrawer}>{children}</Dialog.Root></PhoneContext>;
};

/** Radix owns modal focus, Escape, outside dismissal and return to the header trigger. */
export const SessionDrawer = () => {
  const { narrow } = usePhoneFrame();
  if (!narrow) return null;
  return <Dialog.Portal>
    <Dialog.Overlay className="phone-frame-scrim fixed inset-0 z-40 bg-scrim/30" />
    <Dialog.Content onKeyDown={event => event.stopPropagation()} aria-describedby={undefined} className="phone-frame-drawer fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden rounded-r-xl border-r border-hairline bg-float text-ink outline-none">
      <Dialog.Title className="sr-only">Sessions</Dialog.Title>
      <Sidebar />
    </Dialog.Content>
  </Dialog.Portal>;
};
export const SessionDrawerTrigger = Dialog.Trigger;
