/** Native controls keep their ordinary keys; no global binding takes text from an editor. */
const CONTROLS = [
  { action: "Create, edit and save an owned instruction", keys: "Tab to control; Enter" },
  { action: "Switch an owned instruction on or off", keys: "Tab to Enabled; Space" },
  { action: "Choose all accounts or an instruction's account scope", keys: "Tab to checkbox; Space" },
  { action: "Move an owned instruction up or down", keys: "Tab to Move up or Move down; Enter" },
  { action: "Remove an owned instruction, confirmed once", keys: "Tab to Remove; Enter" },
  { action: "Tick a suggested instruction from the catalogue", keys: "Tab to checkbox; Space" },
  { action: "Dismiss or restore a suggested instruction", keys: "Tab to Dismiss or Restore; Enter" },
  { action: "See what changed in an instruction's source and copy", keys: "Tab to See what changed; Enter" },
  { action: "Replace with new text or Keep mine", keys: "Tab to choice in comparison; Enter" },
  { action: "Turn Tell agents about this computer on or off", keys: "Tab to Tell agents about this computer; Space" },
  { action: "Edit or clear session instructions from its menu", keys: "Shift+F10 on session; arrows to Session instructions; Enter" },
  { action: "Close an instruction editor or comparison", keys: "Esc" },
] as const;

export const instructionControlsMatching = (query: string) =>
  CONTROLS.filter((row) =>
    query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .every((word) => `instructions ${row.action} ${row.keys}`.toLowerCase().includes(word)),
  );
export const InstructionControlShortcuts = ({ rows }: { readonly rows: ReturnType<typeof instructionControlsMatching> }) =>
  rows.length === 0 ? null : (
    <table aria-label="Instructions controls" className="w-full border-collapse text-left text-sm">
      <caption className="py-1 text-left text-xs font-semibold text-ink-muted">Instructions controls</caption>
      <thead>
        <tr className="border-b border-hairline text-xs text-ink-faint">
          <th scope="col">Action</th>
          <th scope="col">Terminal UI</th>
          <th scope="col">GUI</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.action} className="border-b border-hairline">
            <td className="py-2 text-ink">{row.action}</td>
            <td className="text-ink-faint">—</td>
            <td className="text-ink-muted">{row.keys}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
