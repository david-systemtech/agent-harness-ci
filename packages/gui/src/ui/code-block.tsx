import { CopyButton } from "./copy-button.js";
export const CodeBlock = ({ text, copy }: { readonly text: string; readonly copy: (text: string) => Promise<void> }) => <div className="group relative min-w-0">
  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border border-hairline bg-wash px-2.5 py-2 pr-10 font-mono text-[0.6875rem] leading-relaxed text-ink"><code>{text}</code></pre>
  <span className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"><CopyButton text={text} copy={copy} /></span>
</div>;
