import type { Rule } from "eslint";
import { rule } from "./no-literal-colour.js";
import { gui, ruleTester, stylesheetTester } from "./rule-tester.js";

const literal = (colour: string) => ({ messageId: "literal" as const, data: { colour } });
const named = (colour: string) => ({ messageId: "named" as const, data: { colour } });
const tailwind = (colour: string) => ({ messageId: "tailwind" as const, data: { colour } });

/** Tailwind 4's palette, from the default theme it ships (`tailwindcss/theme.css` at 4.3). */
const hues = "red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose slate gray zinc neutral stone mauve olive mist taupe".split(" ");
const shades = "50 100 200 300 400 500 600 700 800 900 950".split(" ");
const palette = hues.flatMap((hue) => shades.map((shade) => `bg-${hue}-${shade}`));

ruleTester.run("no-literal-colour", rule, {
  valid: [
    { filename: gui("app.ts"), code: `const label = "Canvas";` },
    // Not colours: a link's fragment, an entity, a fragment reference, a longer or shorter run, a hash inside a word.
    { filename: gui("app.tsx"), code: `const a = <a href="#main">Skip</a>;` },
    { filename: gui("app.ts"), code: `const a = ["&#123;", "url(#fade)", "#12345", "#12", "docs#abc", "#fffg"];` },
    // A colour function's name as a word, or a function that is not a colour.
    { filename: gui("app.ts"), code: `const a = ["rgb", "colour(s)", "my-rgb(1 2 3)", "calc(1px + 2px)"];` },
    // Token classes, the environment colours' included, and the utilities that name no colour.
    { filename: gui("app.tsx"), code: `const a = <div className="bg-beam text-ink border-line-strong bg-environment-red text-cyan bg-amber-ink" />;` },
    { filename: gui("app.tsx"), code: `const a = <div className="whitespace-nowrap text-current bg-transparent fill-current stroke-inherit shadow-lg ring-2" />;` },
    { filename: gui("app.tsx"), code: `const a = <div className="bg-(--beam) text-[var(--ink)] border-[color:var(--line)] shadow-[0_0_0_1px_var(--line)]" />;` },
    // Words that end like a black or white utility but are none.
    { filename: gui("app.ts"), code: `const a = ["off-white", "black-and-white", "white", "black"];` },
    // A colour name held as data, such as an environment's colour, and a class built from it at run time.
    { filename: gui("app.ts"), code: `const environment = { name: "work", colour: "red" }; const badge = \`bg-environment-\${environment.colour}\`;` },
    { filename: gui("app.tsx"), code: `const a = <EnvironmentBadge colour="red" color="blue" fill="green" />;` },
    { filename: gui("app.ts"), code: `const a = { color: "red" }; element.dataset.color = "red"; const b = new Map([["red", 1]]);` },
    // Named colours in a style: `transparent`, `currentColor` and `inherit` pass, and so do the words of quoted text and a url().
    {
      filename: gui("app.tsx"),
      code: `const a = <div style={{ color: "var(--ink)", fill: "currentColor", outlineColor: "transparent", background: "inherit", fontFamily: '"Gold Sans", serif', backgroundImage: "url(red.png)" }} />;`,
    },
    { filename: gui("logo.tsx"), code: `const a = <svg viewBox="0 0 8 8"><path fill="currentColor" stroke="none" /></svg>;` },
    // A token and currentColor pass everywhere: alone, mixed, and as the origin of a relative colour.
    {
      filename: gui("app.tsx"),
      code: `const a = <div className="bg-(--beam) text-current" style={{ color: "var(--ink)", borderColor: "currentColor", background: "color-mix(in oklch, var(--beam) 20%, transparent)", outlineColor: "oklch(from var(--beam) l c h / 50%)", boxShadow: "0 0 0 1px rgb(from currentColor r g b / 0.4)" }} />;`,
    },
    { filename: gui("app.ts"), code: "const a = [`hsl(from var(--signal) h s calc(l - 10%))`, \"shadow-[0_0_0_1px_oklch(from_var(--line)_l_c_h)]\"];" },
    { filename: gui("logo.tsx"), code: `const a = <path fill="var(--beam)" stroke="currentColor" />;` },
  ],
  invalid: [
    // Hex colours of three, four, six and eight digits.
    { filename: gui("app.ts"), code: `const a = "#fff";`, errors: [literal("#fff")] },
    { filename: gui("app.ts"), code: `const a = "#ffff";`, errors: [literal("#ffff")] },
    { filename: gui("app.ts"), code: `const a = "#a1b2c3";`, errors: [literal("#a1b2c3")] },
    { filename: gui("app.ts"), code: `const a = "#A1B2C3D4";`, errors: [literal("#A1B2C3D4")] },
    // In a template literal, a JSX attribute and a longer value.
    { filename: gui("app.ts"), code: "const a = `0 0 0 1px #000 ${inset}`;", errors: [literal("#000")] },
    { filename: gui("logo.tsx"), code: `const a = <path fill="#1a1a1a" d="M0 0" />;`, errors: [literal("#1a1a1a")] },
    { filename: gui("app.ts"), code: `const a = "1px solid #abc, 2px dashed #def";`, errors: [literal("#abc"), literal("#def")] },
    // rgb(), hsl(), oklch(), color() and their alpha forms; the other literal colour functions.
    { filename: gui("app.ts"), code: `const a = "rgb(0 0 0)";`, errors: [literal("rgb(0 0 0)")] },
    { filename: gui("app.ts"), code: `const a = "rgba(0, 0, 0, 0.5)";`, errors: [literal("rgba(0, 0, 0, 0.5)")] },
    { filename: gui("app.ts"), code: `const a = "hsl(210 40% 50%)";`, errors: [literal("hsl(210 40% 50%)")] },
    { filename: gui("app.ts"), code: `const a = "HSLA(210, 40%, 50%, 0.3)";`, errors: [literal("HSLA(210, 40%, 50%, 0.3)")] },
    { filename: gui("app.ts"), code: `const a = "oklch(0.62 0.18 264)";`, errors: [literal("oklch(0.62 0.18 264)")] },
    { filename: gui("app.ts"), code: `const a = "oklch(0.62 0.18 264 / 50%)";`, errors: [literal("oklch(0.62 0.18 264 / 50%)")] },
    { filename: gui("app.ts"), code: `const a = "color(display-p3 1 0 0 / 0.5)";`, errors: [literal("color(display-p3 1 0 0 / 0.5)")] },
    { filename: gui("app.ts"), code: `const a = ["hwb(0 0% 0%)", "lab(50% 40 59)", "lch(52% 72 50)", "oklab(0.6 0.1 0.1)"];`, errors: [literal("hwb(0 0% 0%)"), literal("lab(50% 40 59)"), literal("lch(52% 72 50)"), literal("oklab(0.6 0.1 0.1)")] },
    { filename: gui("app.tsx"), code: "const a = <div style={{ boxShadow: `0 0 4px rgba(0,0,0,${alpha})` }} />;", errors: [literal("rgba(0,0,0,")] },
    // A token's fallback is a literal colour, and so is a relative colour from one.
    { filename: gui("app.ts"), code: `const a = "var(--beam, #3b82f6)";`, errors: [literal("#3b82f6")] },
    { filename: gui("app.ts"), code: `const a = "oklch(from #3b82f6 l c h) rgb(from red r g b)";`, errors: [literal("oklch(from #3b82f6 l c h)"), literal("rgb(from red r g b)")] },
    // Named colour keywords in style objects: a style attribute's, one it names, one spread into it, and every value in it.
    { filename: gui("app.tsx"), code: `const a = <div style={{ color: "red" }} />;`, errors: [named("red")] },
    {
      filename: gui("app.tsx"),
      code: "const a = <div style={{ border: \"1px solid Crimson\", background: active ? `white` : \"var(--panel)\", \"&:hover\": { color: \"navy\" } }} />;",
      errors: [named("Crimson"), named("white"), named("navy")],
    },
    {
      filename: gui("app.tsx"),
      code: `const base = { outlineColor: "gold" }; const errorStyle = { ...base, color: "tomato" }; const a = <p style={errorStyle} />;`,
      errors: [named("gold"), named("tomato")],
    },
    // Style objects by their type, and the DOM's style object.
    {
      filename: gui("app.ts"),
      code: `const a: CSSProperties = { color: "gold" }; const b = { color: "teal" } satisfies React.CSSProperties; const c = { fill: "olive" } as CSSProperties;`,
      errors: [named("gold"), named("teal"), named("olive")],
    },
    {
      filename: gui("app.ts"),
      code: `element.style.color = "red"; element.style.setProperty("background-color", "blue"); element.style.cssText = "border: 1px solid green";`,
      errors: [named("red"), named("blue"), named("green")],
    },
    // An SVG element's colour attributes are its style: logos use currentColor.
    {
      filename: gui("logo.tsx"),
      code: `const a = <svg><path fill="black" /><circle stroke={"orange"} /><stop stopColor="white" /></svg>;`,
      errors: [named("black"), named("orange"), named("white")],
    },
    // Tailwind's palette classes: every hue and shade.
    { filename: gui("app.ts"), code: `const a = "${palette.join(" ")}";`, errors: palette.map(tailwind) },
    // Behind variants, with an opacity modifier, marked important.
    {
      filename: gui("app.tsx"),
      code: `const a = <div className="p-2 hover:bg-sky-300/50 dark:md:text-slate-100 !border-zinc-800 ring-rose-500! data-[state=open]:from-violet-50 [&>svg]:fill-emerald-600/[0.4]" />;`,
      errors: ["hover:bg-sky-300/50", "dark:md:text-slate-100", "!border-zinc-800", "ring-rose-500!", "data-[state=open]:from-violet-50", "[&>svg]:fill-emerald-600/[0.4]"].map(tailwind),
    },
    // Every colour utility, with the black and white utilities.
    {
      filename: gui("app.ts"),
      code: `const a = "accent-white border-x-black border-bs-white caret-black decoration-white divide-black drop-shadow-white inset-ring-black inset-shadow-white outline-black placeholder-white ring-offset-black scrollbar-thumb-white stroke-black text-shadow-white via-black to-white mask-radial-from-black";`,
      errors: ["accent-white", "border-x-black", "border-bs-white", "caret-black", "decoration-white", "divide-black", "drop-shadow-white", "inset-ring-black", "inset-shadow-white", "outline-black", "placeholder-white", "ring-offset-black", "scrollbar-thumb-white", "stroke-black", "text-shadow-white", "via-black", "to-white", "mask-radial-from-black"].map(tailwind),
    },
    // Arbitrary colour values: a named colour is the class's, a hex or a colour function the literal's.
    {
      filename: gui("app.tsx"),
      code: `const a = <div className="bg-[red] text-[color:tomato] [color:navy] border-[var(--line,crimson)] bg-[#0f0] shadow-[0_0_0_1px_rgb(0_0_0)]" />;`,
      errors: [tailwind("bg-[red]"), tailwind("text-[color:tomato]"), tailwind("[color:navy]"), tailwind("border-[var(--line,crimson)]"), literal("#0f0"), literal("rgb(0_0_0)")],
    },
    // Tailwind's palette through its theme variables, which a custom property reference would otherwise let through.
    {
      filename: gui("app.tsx"),
      code: `const a = <div className="bg-(--color-sky-500) text-[var(--color-white)]" style={{ color: "var(--color-red-600)" }} />;`,
      errors: [tailwind("--color-sky-500"), tailwind("--color-white"), tailwind("--color-red-600")],
    },
    // Joined by the usual class helpers, in a template, and in a variable holding classes.
    {
      filename: gui("app.tsx"),
      code: `const a = <div className={clsx("p-2", { "bg-black": active }, disabled && "text-gray-400")} />;`,
      errors: [tailwind("bg-black"), tailwind("text-gray-400")],
    },
    {
      filename: gui("button.ts"),
      code: `const button = cva("bg-slate-900", { variants: { tone: { danger: "text-red-600", quiet: cn("text-ink", twMerge("border-white")) } } });`,
      errors: [tailwind("bg-slate-900"), tailwind("text-red-600"), tailwind("border-white")],
    },
    {
      filename: gui("app.tsx"),
      code: "const base = `rounded ${size} bg-white`; const a = <div className={`${base} text-black`} />;",
      errors: [tailwind("bg-white"), tailwind("text-black")],
    },
  ],
});

// The same refusals in a stylesheet, parsed by ESLint's CSS language. ESLint's tester types a rule as ESLint's own; the object is the same.
stylesheetTester.run("no-literal-colour in a stylesheet", rule as unknown as Rule.RuleModule, {
  valid: [
    // A Tailwind 4 stylesheet mapping the theme's tokens, which paints only with tokens and currentColor.
    `@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
@theme inline { --color-*: initial; --color-beam: var(--beam); --color-ink: var(--ink); }
body { background: var(--abyss); color: var(--ink); border-color: currentColor; outline-color: transparent; fill: inherit; }
.logo { color: currentColor; }
.wash { background: color-mix(in oklch, var(--beam) 20%, transparent); color: oklch(from var(--beam) l c h / 50%); }
.chip { @apply bg-beam text-ink rounded; }`,
    // Quoted text, a url(), a selector and a comment hold no colour.
    `.a { content: "red #fff"; background-image: url(red.png); font-family: "Gold Sans", serif; }`,
    `.bg-red-500, [data-colour="red"] { color: var(--ink); } /* #fff red */`,
  ],
  invalid: [
    {
      code: `.a { color: #fff; border: 1px solid #ffff; background: #a1b2c3; outline-color: #A1B2C3D4; }`,
      errors: [literal("#fff"), literal("#ffff"), literal("#a1b2c3"), literal("#A1B2C3D4")],
    },
    {
      code: `.a { color: rgb(0 0 0); background: hsla(0, 0%, 0%, .5); fill: oklch(0.6 0.1 200 / 50%); stroke: color(display-p3 1 0 0); }`,
      errors: [literal("rgb(0 0 0)"), literal("hsla(0, 0%, 0%, .5)"), literal("oklch(0.6 0.1 200 / 50%)"), literal("color(display-p3 1 0 0)")],
    },
    {
      code: `.a { color: red; border: 1px solid Crimson; box-shadow: 0 0 0 1px navy; background: rgb(from red r g b); }`,
      errors: [named("red"), named("Crimson"), named("navy"), literal("rgb(from red r g b)")],
    },
    // A custom property's value, a token's fallback, and the theme block.
    { code: `:root { --panel: #111; --ink: white; }`, errors: [literal("#111"), named("white")] },
    { code: `.a { color: var(--ink, black); }`, errors: [named("black")] },
    { code: `@theme inline { --color-brand: oklch(0.6 0.2 264); }`, errors: [literal("oklch(0.6 0.2 264)")] },
    { code: `.a { color: var(--color-zinc-900); border-color: theme(--color-black); }`, errors: [tailwind("--color-zinc-900"), tailwind("--color-black")] },
    // Tailwind's colour classes applied in a stylesheet.
    { code: `.a { @apply rounded bg-red-500 hover:text-white; }`, errors: [tailwind("bg-red-500"), tailwind("hover:text-white")] },
  ],
});
