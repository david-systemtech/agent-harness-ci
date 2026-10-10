import { Dialog } from "radix-ui";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { Sidebar, type SidebarProps } from "../sidebar/sidebar.js";
import "./phone-frame.css";

interface PhoneFrame {
  readonly narrow: boolean;
  readonly drawerShown: boolean;
  readonly drawerTrigger: RefObject<HTMLButtonElement | null>;
  /** Where focus returns when the drawer closes, if not the header's trigger. */
  readonly drawerOpener: RefObject<HTMLElement | null>;
  /** Whether closing restores focus; a new session explicitly keeps it in its message box. */
  readonly drawerRestoreFocus: RefObject<boolean>;
  /** `opener` is a control other than the header's trigger; `restoreFocus` defaults to true. */
  showDrawer(shown: boolean, options?: { readonly opener?: HTMLElement; readonly restoreFocus?: boolean }): void;
}
const PhoneContext = createContext<PhoneFrame>({ narrow: false, drawerShown: false, drawerTrigger: { current: null }, drawerOpener: { current: null }, drawerRestoreFocus: { current: true }, showDrawer: () => undefined });
export const usePhoneFrame = () => use(PhoneContext);

/** Classify layout bounds, never keyboard/zoom-reduced VisualViewport dimensions.
 * Short landscape phones retain the portrait projection; larger touch screens stay wide. */
export const phoneLayoutMedia = () => [
  window.matchMedia("(width < 640px)"),
  window.matchMedia("(pointer: coarse) and (hover: none) and (640px <= width <= 960px) and (height <= 500px)"),
];

/** Layout changes only the projection; desktop sidebar preferences and pane sizes stay held. */
export const PhoneFrameProvider = ({ children }: { readonly children: ReactNode }) => {
  const [media] = useState(phoneLayoutMedia);
  const [narrow, setNarrow] = useState(() => media.some(query => query.matches));
  const [drawerShown, setDrawerShown] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const drawerOpener = useRef<HTMLElement>(null);
  const drawerRestoreFocus = useRef(true);
  const showDrawer = useCallback<PhoneFrame["showDrawer"]>((shown, options) => {
    if (shown) drawerOpener.current = options?.opener ?? null;
    drawerRestoreFocus.current = options?.restoreFocus ?? true;
    setDrawerShown(shown);
  }, []);
  useEffect(() => {
    const changed = () => { const phone = media.some(query => query.matches); setNarrow(phone); if (!phone) setDrawerShown(false); };
    media.forEach(query => query.addEventListener("change", changed));
    changed();
    return () => media.forEach(query => query.removeEventListener("change", changed));
  }, [media]);
  const value = useMemo(() => ({ narrow, drawerShown, drawerTrigger, drawerOpener, drawerRestoreFocus, showDrawer }), [narrow, drawerShown, showDrawer]);
  return <PhoneContext value={value}><Dialog.Root open={narrow && drawerShown} onOpenChange={showDrawer}>{children}</Dialog.Root></PhoneContext>;
};

/** Radix owns modal trapping and dismissal; focus changes never scroll the document.
 * Closing hands focus back to what opened the drawer. New session explicitly leaves it in
 * its message box (#1902); incidental focus during the delayed close cannot change that decision. */
export const SessionDrawer = (props: SidebarProps = {}) => {
  const { narrow, drawerTrigger, drawerOpener, drawerRestoreFocus } = usePhoneFrame();
  const content = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  if (!narrow) return null;
  const handBack = () => {
    if (!drawerRestoreFocus.current) return;
    (drawerOpener.current?.isConnected ? drawerOpener.current : drawerTrigger.current)?.focus({ preventScroll: true });
  };
  // Portal into the viewport owner so absolute bounds follow its height and top.
  return <><span hidden ref={setAnchor} /><Dialog.Portal container={anchor?.closest<HTMLElement>("[data-web-client]") ?? undefined}>
    <Dialog.Overlay className="phone-frame-scrim fixed inset-0 z-40 bg-scrim/30" />
    <Dialog.Content ref={content} onOpenAutoFocus={event => { event.preventDefault(); content.current?.focus({ preventScroll: true }); }} onCloseAutoFocus={event => { event.preventDefault(); handBack(); }} onKeyDown={event => event.stopPropagation()} aria-describedby={undefined} className="phone-frame-drawer fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden rounded-r-xl border-r border-hairline bg-float text-ink outline-none">
      <Dialog.Title className="sr-only">Sessions</Dialog.Title>
      <Sidebar {...props} />
    </Dialog.Content>
  </Dialog.Portal></>;
};
export const SessionDrawerTrigger = (props: Omit<ComponentProps<typeof Dialog.Trigger>, "ref">) => {
  const { drawerTrigger } = usePhoneFrame();
  return <Dialog.Trigger {...props} ref={drawerTrigger} />;
};
