import { RunPickerScene } from "./run-picker.js";
export { script, arrange } from "./run-picker.js";
export default function NarrowRunPickerScene() { return <RunPickerScene compact />; }
/** look.md §10.6: the same stages stacked in a dialog bounded below 512px. */
export const geometry = [{ selector: '[data-run-picker][data-narrow="true"]', width: 480 }];
