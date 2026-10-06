import { act, fireEvent, render, screen } from "@testing-library/react";
import { KeyRound } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountAction } from "../accounts/action.js";
import { PhoneFrameProvider } from "../frame/phone-frame.js";
import { ChoiceList } from "../settings/part.js";
import { IconButton } from "./button.js";
import { DialogAction } from "./dialog-action.js";
import { Tooltip, TooltipProvider } from "./tooltip.js";

/**
 * Hints on the phone layout (#1741): a phone has no keyboard to read a key
 * legend from, and the app moving focus (a sheet restored on reload) must not
 * float a hint over the window's own text. Only a Tab press reveals one there.
 */
afterEach(() => { vi.restoreAllMocks(); });

const phoneLayout = () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
};

describe("on the phone layout", () => {
  it("shows no hint when the app moves focus before any input", () => {
    phoneLayout();
    render(<PhoneFrameProvider><TooltipProvider><IconButton label="Close side sheet" keys="Enter / Space" /></TooltipProvider></PhoneFrameProvider>);
    act(() => screen.getByRole("button", { name: "Close side sheet" }).focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps the hint closed after a key that is not Tab, and opens it on Tab without a key legend", () => {
    phoneLayout();
    render(<PhoneFrameProvider><TooltipProvider><IconButton label="Close side sheet" keys="Enter / Space" /><Tooltip content="Leave for now" keys="Tab, Enter"><button>Leave for now</button></Tooltip></TooltipProvider></PhoneFrameProvider>);
    const close = screen.getByRole("button", { name: "Close side sheet" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    act(() => close.focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(close, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Leave for now" }).focus());
    expect(screen.getByRole("tooltip").textContent).toBe("Leave for now");
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    act(() => close.focus());
    expect(screen.getByRole("tooltip").textContent).toBe("Close side sheet");
  });

  it("draws a dialog action's hint without its key legend", () => {
    phoneLayout();
    render(<PhoneFrameProvider><TooltipProvider><DialogAction>Pair</DialogAction></TooltipProvider></PhoneFrameProvider>);
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Pair" }).focus());
    expect(screen.getByRole("tooltip").textContent).toBe("Pair");
  });

  it("draws an account action's and a settings choice's hints without their key legends", () => {
    phoneLayout();
    render(<PhoneFrameProvider><TooltipProvider>
      <AccountAction icon={KeyRound}>Sign in</AccountAction>
      <ChoiceList label="Effort" value="high" choices={[{ value: "high", label: "High", note: "Thinks longer." }]} onValueChange={() => undefined} />
    </TooltipProvider></PhoneFrameProvider>);
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Sign in" }).focus());
    expect(screen.getByRole("tooltip").textContent).toBe("Sign in");
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("radio", { name: "High" }).focus());
    expect(screen.getByRole("tooltip").textContent).toBe("High");
  });
});

it("keeps the key legend and the hint on first focus in a wide window", () => {
  render(<PhoneFrameProvider><TooltipProvider><Tooltip content="Leave for now" keys="Tab, Enter"><button>Leave for now</button></Tooltip></TooltipProvider></PhoneFrameProvider>);
  act(() => screen.getByRole("button", { name: "Leave for now" }).focus());
  expect(screen.getByRole("tooltip").textContent).toBe("Leave for now · Tab, Enter");
});
