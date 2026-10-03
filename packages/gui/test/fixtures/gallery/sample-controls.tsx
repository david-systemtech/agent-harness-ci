import type { LadderName } from "@agent-harness/theme";

export default function SampleControls({ ladder }: { readonly ladder: LadderName }) {
  return <><button data-ladder={ladder}>Add item</button><input aria-label="Item name" /></>;
}
export const geometry = [{ selector: "button", height: 32 }, { selector: "input", height: 32 }];
