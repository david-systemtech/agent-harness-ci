import { useState } from "react";
import { FilesPane, type FilesPlace } from "../../src/side-column/files-pane.js";
import { DockHeader } from "../../src/side-column/dock-header.js";
import type { SceneGeometry } from "../scene-registry.js";

import { script as folderScript } from "./dock-files.js";

const environmentId = "0199cc00-0000-4000-8000-000000000001";
const sessionId = "0199dd00-0000-4000-8000-000000000001";
export const script = { environments: folderScript.environments.map((environment) => ({ ...environment, fileContents: {
  "src/totals.ts": "// Totals from the receipts\nexport const total = (values: number[]) => {\n  return values.reduce((sum, value) => sum + value, 0);\n};\n",
} })) };

/** Real Files pane over the gallery runtime; an initially opened source file. */
export default function FileViewScene() {
  const [place, go] = useState<FilesPlace>({ directory: "src", file: "src/totals.ts" });
  return <main className="flex h-screen items-start justify-center bg-abyss p-6 text-ink">
    <section aria-label="Files" className="flex h-[740px] w-[480px] min-w-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
      <DockHeader pane="files" hide={() => {}} />
      <FilesPane environmentId={environmentId} sessionId={sessionId} place={place} go={go} />
    </section>
  </main>;
}

/** look.md §§8.2 and 9.3: physical 40px gutter, 24px controls and 30px pane header. */
export const geometry: readonly SceneGeometry[] = [
  { selector: "[data-file-gutter]", width: 40 },
  { selector: "[data-file-header] button", width: 24, height: 24 },
  { selector: "[data-dock-header]", height: 30 },
];
