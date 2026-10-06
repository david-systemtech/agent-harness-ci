import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { CharacterCount } from "@tiptap/extensions";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { Bold, Code, Heading2, Heading3, Italic, Link, List, ListOrdered, Quote, SquareCode } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Textarea, Tooltip } from "./index.js";

// The extension publishes this storage but does not augment Tiptap's storage interface.
declare module "@tiptap/core" { interface Storage { markdown: MarkdownStorage & { readonly serializer: { serialize(node: Node): string } } } }

/** A Markdown draft at the boundary; rich editing never persists HTML. look.md §8.3. */
export const MarkdownEditor = ({ value, change, readOnly = false, label = "Markdown body", maxLength }: {
  readonly value: string;
  readonly change: (text: string) => void;
  readonly readOnly?: boolean;
  readonly label?: string;
  readonly maxLength?: number;
}) => {
  const [link, setLink] = useState<string | null>(null);
  const [sourceEditing, setSourceEditing] = useState(false);
  const firstLoad = useRef(true);
  const lastMarkdown = useRef(value);
  const linkHandled = useRef(false);
  const extensions = useMemo(() => [StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false }, underline: false }),
      Markdown.configure({ html: false, tightLists: true, bulletListMarker: "-", transformPastedText: true, transformCopiedText: true }),
      CharacterCount.configure({ limit: maxLength }),
      Extension.create({
        name: "markdownLength",
        addProseMirrorPlugins() {
          const serialize = (node: Node) => this.editor.storage.markdown.serializer.serialize(node).length;
          return [new Plugin({ filterTransaction: (transaction, state) =>
            !transaction.docChanged || maxLength === undefined || serialize(transaction.doc) <= maxLength || serialize(transaction.doc) < serialize(state.doc),
          })];
        },
      })], [maxLength]);
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions,
    content: value,
    editable: !readOnly,
    editorProps: { attributes: {
      role: "textbox", "aria-label": label, title: `${label} · Type to edit · Mod+B bold · Mod+I italic`, "aria-multiline": "true", "aria-readonly": String(readOnly),
      class: "min-h-32 px-3 py-2.5 text-sm leading-[1.6] text-ink outline-none [overflow-wrap:anywhere] [&_h2]:font-semibold [&_h3]:font-semibold [&_h2]:leading-[1.3] [&_h3]:leading-[1.3] [&_p]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-hairline-strong [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted [&_pre]:rounded-md [&_pre]:bg-inset [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_a]:text-beam-text [&_a]:underline",
    } },
    onUpdate: ({ editor }) => {
      const markdown = editor.storage.markdown.getMarkdown();
      lastMarkdown.current = markdown;
      change(markdown);
    },
  });
  useEffect(() => {
    if (editor === null) return;
    const editable = !readOnly && !sourceEditing;
    if (editor.isEditable !== editable) editor.setEditable(editable, false);
    editor.view.dom.setAttribute("aria-readonly", String(readOnly));
    if (firstLoad.current || lastMarkdown.current !== value) {
      firstLoad.current = false;
      lastMarkdown.current = value;
      editor.commands.setContent(value, { emitUpdate: false });
      // Use source editing whenever the rich document would rewrite the original Markdown.
      setSourceEditing(editor.storage.markdown.getMarkdown() !== value);
    }
  }, [editor, readOnly, sourceEditing, value]);
  useEffect(() => { if (readOnly) setLink(null); }, [readOnly]);
  if (editor === null) return null;
  if (sourceEditing) return <div data-markdown-editor className="overflow-hidden rounded-lg border border-hairline bg-panel">
    <p className="px-3 pt-2 text-2xs text-ink-muted">Markdown source</p>
    <Textarea aria-label={label} aria-readonly={readOnly} readOnly={readOnly} value={value} maxLength={maxLength} className="min-h-32 rounded-none border-0 font-mono" onChange={(event) => {
      const markdown = event.target.value;
      if (readOnly || (maxLength !== undefined && markdown.length > maxLength && markdown.length >= value.length)) return;
      lastMarkdown.current = markdown;
      change(markdown);
    }} />
  </div>;
  const controls = [
    { name: "Heading 2", icon: Heading2, active: editor.isActive("heading", { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), keys: "Mod+Alt+2" },
    { name: "Heading 3", icon: Heading3, active: editor.isActive("heading", { level: 3 }), run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(), keys: "Mod+Alt+3" },
    { name: "Bold", icon: Bold, active: editor.isActive("bold"), run: () => editor.chain().focus().toggleBold().run(), keys: "Mod+B", separator: true },
    { name: "Italic", icon: Italic, active: editor.isActive("italic"), run: () => editor.chain().focus().toggleItalic().run(), keys: "Mod+I" },
    { name: "Inline code", icon: Code, active: editor.isActive("code"), run: () => editor.chain().focus().toggleCode().run(), keys: "Mod+E" },
    { name: "Bullet list", icon: List, active: editor.isActive("bulletList"), run: () => editor.chain().focus().toggleBulletList().run(), keys: "Mod+Shift+8", separator: true },
    { name: "Ordered list", icon: ListOrdered, active: editor.isActive("orderedList"), run: () => editor.chain().focus().toggleOrderedList().run(), keys: "Mod+Shift+7" },
    { name: "Quote", icon: Quote, active: editor.isActive("blockquote"), run: () => editor.chain().focus().toggleBlockquote().run(), keys: "Mod+Shift+B" },
    { name: "Code block", icon: SquareCode, active: editor.isActive("codeBlock"), run: () => editor.chain().focus().toggleCodeBlock().run(), keys: "Mod+Alt+C" },
    { name: "Link", icon: Link, active: editor.isActive("link"), run: () => { linkHandled.current = false; setLink(String(editor.getAttributes("link")["href"] ?? "")); }, keys: "Enter to edit URL", separator: true },
  ];
  const applyLink = () => {
    if (link === null || readOnly || linkHandled.current) return;
    linkHandled.current = true;
    const chain = editor.chain().focus().extendMarkRange("link");
    if (link.trim() === "") chain.unsetLink().run();
    else chain.setLink({ href: link.trim() }).run();
    setLink(null);
  };
  return <div data-markdown-editor className="overflow-hidden rounded-lg border border-hairline bg-panel focus-within:border-beam focus-within:ring-3 focus-within:ring-beam/50">
    {!readOnly && <div role="toolbar" aria-label="Markdown formatting" className="flex flex-wrap items-center gap-0.5 border-b border-hairline bg-wash px-1.5 py-1">
      {controls.map(({ name, icon: Icon, active, run, keys, separator }) => <span key={name} className={separator ? "ml-1 border-l border-hairline pl-1" : "inline-flex"}>
        <Tooltip content={name} keys={keys}><Button size="icon-sm" aria-label={name} aria-pressed={active} className={active ? "bg-wash-strong" : undefined} onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon aria-hidden="true" /></Button></Tooltip>
      </span>)}
      {link !== null && <Input data-local-escape autoFocus aria-label="Link URL" title="Link URL · Enter or blur to apply · Escape to cancel" value={link} className="h-7 w-56 rounded-md px-2 font-mono text-2xs" onChange={(event) => setLink(event.target.value)} onBlur={applyLink} onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); applyLink(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); linkHandled.current = true; setLink(null); editor.commands.focus(); }
      }} />}
    </div>}
    <EditorContent editor={editor} />
  </div>;
};
