// Writes one thin gallery scene per prototype screen. Copy this folder to packages/gui/gallery/proto/,
// run `node gallery/proto/make-scenes.mjs` from packages/gui, then build the gallery and open
// gallery.html?scene=<name>&ladder=dark at 390x844. Never commit the generated scenes/proto-*.tsx.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
const scenes = {
  "proto-phone-conversation-permission": ["conversation", "ConversationPermission"],
  "proto-phone-conversation-idle": ["conversation", "ConversationIdle"],
  "proto-phone-conversation-working": ["conversation", "ConversationWorking"],
  "proto-phone-conversation-keyboard": ["conversation", "ConversationKeyboard"],
  "proto-phone-sessions": ["screens", "Sessions"],
  "proto-phone-run-settings": ["screens", "RunSettings"],
  "proto-phone-settings": ["screens", "SettingsRoot"],
  "proto-phone-plan": ["screens", "PlanSheet"],
  "proto-phone-files": ["screens", "FilesPage"],
  "proto-phone-pairing": ["screens", "Pairing"],
};
for (const [name, [module, component]] of Object.entries(scenes)) {
  writeFileSync(resolve(import.meta.dirname, "../scenes", `${name}.tsx`), `import { ${component} } from "../proto/${module}.js";\nexport default function Scene() { return <${component} />; }\n`);
}
