import type { Rule } from "eslint";
import { vi } from "vitest";
import { rule } from "./no-unmapped-colour-class.js";
import { gui, markupTester, ruleTester, stylesheetTester } from "./rule-tester.js";

// Supply theme declarations at the filesystem boundary without changing the window's scale.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    const content = fs.readFileSync(...args);
    if (args[0] instanceof URL && args[0].pathname.endsWith("/packages/gui/src/styles.css")) {
      return `${content as string}
        @theme inline {
          --text-2xs: 11px;
          --text-2xs--line-height: 16px;
          --text-caption: var(--caption-size);
          --text-retired: initial;
          /* --text-commented: 10px; */
        }
        :root { --text-local: 10px; }
      `;
    }
    return content;
  } };
});

const unmapped = (colour: string) => ({ messageId: "unmapped" as const, data: { colour } });

ruleTester.run("no-unmapped-colour-class declared sizes", rule, {
  valid: [
    { filename: gui("app.tsx"), code: 'const a = <div className="text-2xs text-ink-muted hover:text-2xs md:!text-2xs/6 data-[state=open]:text-caption! [&:nth-child(2)]:text-caption/normal" />;' },
  ],
  invalid: [
    { filename: gui("app.tsx"), code: 'const a = <div className="text-2xs text-ink-muted hover:text-unknown-colour/50" />;', errors: [unmapped("hover:text-unknown-colour/50")] },
    ...["bg-2xs", "border-caption", "text-2xs--line-height", "text-retired", "text-commented", "text-local"].map((colour) => ({ filename: gui("app.ts"), code: `const a = "${colour}";`, errors: [unmapped(colour)] })),
  ],
});

stylesheetTester.run("no-unmapped-colour-class declared sizes", rule as unknown as Rule.RuleModule, {
  valid: ['.caption { @apply text-2xs text-ink-muted hover:text-caption/6; }'],
  invalid: [{ code: '.caption { @apply text-2xs text-unknown-colour; }', errors: [unmapped("text-unknown-colour")] }],
});

markupTester.run("no-unmapped-colour-class declared sizes", rule as unknown as Rule.RuleModule, {
  valid: ['<div class="text-2xs text-ink-muted hover:text-caption"></div>'],
  invalid: [{ code: '<div class="text-2xs text-unknown-colour"></div>', errors: [unmapped("text-unknown-colour")] }],
});
