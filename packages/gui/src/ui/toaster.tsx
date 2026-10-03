import { CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { useSyncExternalStore, type CSSProperties } from "react";
import { Toaster as SonnerToaster, toast, type ToasterProps } from "sonner";

export { toast };
const subscribeLadder = (changed: () => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ladder"] });
  return () => observer.disconnect();
};
const readLadder = (): "light" | "dark" => document.documentElement.dataset["ladder"] === "light" ? "light" : "dark";

/** The transient lane follows the painted ladder, including previews; persistent notices keep their own lane. */
export const Toaster = (props: ToasterProps) => {
  const ladder = useSyncExternalStore(subscribeLadder, readLadder, (): "dark" => "dark");
  return <SonnerToaster
    theme={ladder}
    position="bottom-right"
    containerAriaLabel="Status feedback"
    closeButton
    richColors={false}
    icons={{ success: <CircleCheck className="size-4" />, info: <Info className="size-4" />, warning: <TriangleAlert className="size-4" />, error: <CircleX className="size-4" />, loading: <LoaderCircle className="size-4 animate-spin" /> }}
    style={{ "--normal-bg": "var(--float)", "--normal-text": "var(--ink)", "--normal-border": "var(--hairline)", "--border-radius": "0.5rem", "--font-family": "var(--font-sans)" } as CSSProperties}
    {...props}
  />;
};
