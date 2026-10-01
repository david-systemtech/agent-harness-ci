/**
 * Markdown from a Readability article (browser spec, "`browser_read`" and
 * "`web_read`"): the reader runs Readability 0.6.0 on the rendered page, or
 * on jsdom for `web_read`, and hands its article here. The Markdown keeps the
 * headings, paragraphs, lists, tables, code and quotations, and the text is
 * kept as written, with no Markdown escaping but a pipe inside a table's
 * cell, which would end the cell: the reader is a model, and verbatim text
 * is the point. Link targets are dropped and the link text
 * kept, unless links are asked for; an image is its alt text.
 *
 * It walks the article's DOM, so it runs wherever the reader does: in the
 * page's isolated world and on jsdom alike. The module is one function that
 * returns what it holds, so it runs from its source text in the page
 * (./reader-in-page.ts): it reaches for nothing outside itself.
 */

/** A Readability article: its title, and its content as an element, which Readability hands over with `serializer: (element) => element`. */
export interface ReaderArticle {
  readonly title?: string | null;
  readonly content: Node;
}

/** What the conversion is asked: whether to keep link targets (preset false). */
export interface MarkdownOptions {
  readonly links?: boolean;
}

/** The Markdown conversion, made afresh wherever it runs: on jsdom, or in a page's isolated world. */
export function markdownModule() {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  /** Elements whose content no reader sees, or that hold only a form's state. */
  const SKIPPED = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link", "iframe", "object", "embed", "svg", "canvas", "input", "select", "textarea", "button"]);

  /** Elements that hold other blocks: their children are read as blocks of their own. */
  const CONTAINERS = new Set([
    "html",
    "body",
    "div",
    "section",
    "article",
    "main",
    "header",
    "footer",
    "aside",
    "nav",
    "address",
    "figure",
    "figcaption",
    "caption",
    "details",
    "summary",
    "dialog",
    "fieldset",
    "form",
    "center",
    "hgroup",
    "p",
    "dd",
    "li",
  ]);

  /** Every element read as a block: the containers, and what has a block form of its own. */
  const BLOCKS = new Set([...CONTAINERS, "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "blockquote", "table", "hr", "dl", "dt"]);

  /** Inline elements written with a Markdown mark around their text. */
  const MARKS: ReadonlyMap<string, string> = new Map([
    ["strong", "**"],
    ["b", "**"],
    ["em", "*"],
    ["i", "*"],
    ["cite", "*"],
    ["dfn", "*"],
    ["del", "~~"],
    ["s", "~~"],
    ["strike", "~~"],
  ]);

  /** Inline elements that are code. */
  const CODE = new Set(["code", "kbd", "samp", "tt"]);

  const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;

  /** A block of Markdown, and whether it is a list, which an item joins to the text before it without a blank line. */
  interface Block {
    readonly text: string;
    readonly list?: true;
  }

  /** HTML's collapsing of white space: every run one space. */
  const collapse = (text: string): string => text.replace(/[ \t\n\r\f]+/g, " ");

  /** Inline Markdown's lines, each trimmed and its runs of spaces made one; a line break stays one. */
  const tidy = (inline: string): string =>
    inline
      .split("\n")
      .map((line) => line.replace(/ {2,}/g, " ").trim())
      .join("\n")
      .trim();

  /** The longest run of backticks in `text`. */
  const longestBacktickRun = (text: string): number => Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));

  /** Inline code, fenced by one more backtick than the longest run it holds, padded where it starts or ends with one. */
  const codeSpan = (text: string): string => {
    const code = collapse(text).trim();
    if (code === "") return "";
    const fence = "`".repeat(longestBacktickRun(code) + 1);
    const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
    return `${fence}${pad}${code}${pad}${fence}`;
  };

  /**
   * Inline text written as `write` gives it, inside any white space at its
   * ends, which stays outside: `a<b> bold </b>b` reads `a **bold** b`. White
   * space alone is left as it is.
   */
  const within = (inner: string, write: (text: string) => string): string => {
    const text = inner.trim();
    if (text === "") return inner;
    const lead = /^\s*/.exec(inner)?.[0] ?? "";
    const trail = /\s*$/.exec(inner)?.[0] ?? "";
    return `${lead}${write(text)}${trail}`;
  };

  /** A link's target worth keeping: a web or mail address, never a script's. */
  const keptTarget = (href: string | null): string | null => (href !== null && href.trim() !== "" && !/^\s*javascript:/i.test(href) ? href.trim() : null);

  /** A pre's text as written: its text nodes, and a line break for each `br`. */
  const preText = (node: Node): string => {
    if (node.nodeType === TEXT_NODE) return node.nodeValue ?? "";
    if (isElement(node) && node.localName === "br") return "\n";
    return Array.from(node.childNodes, preText).join("");
  };

  /** The language a code block names in its class (`language-sh`, `lang-sh`), on the pre or its code. */
  const languageOf = (pre: Element): string => {
    const classes = [pre.getAttribute("class"), pre.querySelector("code")?.getAttribute("class")].join(" ");
    return /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(classes)?.[1] ?? "";
  };

  /** Every line of `text` indented by `width` spaces but the first, which follows a list item's marker. */
  const hanging = (text: string, width: number): string =>
    text
      .split("\n")
      .map((line, index) => (index === 0 || line === "" ? line : `${" ".repeat(width)}${line}`))
      .join("\n");

  class Converter {
    constructor(private readonly links: boolean) {}

    /** A node's inline Markdown: text collapsed, marks, code, links and images, a line break for each `br`. */
    inline(node: Node): string {
      if (node.nodeType === TEXT_NODE) return collapse(node.nodeValue ?? "");
      if (!isElement(node)) return "";
      const name = node.localName;
      if (SKIPPED.has(name)) return "";
      if (name === "br") return "\n";
      if (name === "img") return this.image(node);
      if (CODE.has(name)) return codeSpan(node.textContent ?? "");
      const inner = this.inlineChildren(node);
      const mark = MARKS.get(name);
      if (mark !== undefined) return within(inner, (text) => `${mark}${text}${mark}`);
      if (name === "a") return this.link(node, inner);
      // A block met inside inline content (a heading's, a cell's) runs on as text, set apart by spaces.
      return BLOCKS.has(name) ? ` ${inner} ` : inner;
    }

    private inlineChildren(node: Node): string {
      return Array.from(node.childNodes, (child) => this.inline(child)).join("");
    }

    private image(image: Element): string {
      const alt = collapse(image.getAttribute("alt") ?? "").trim();
      const source = keptTarget(image.getAttribute("src"));
      if (this.links && source !== null) return `![${alt}](${source})`;
      return alt === "" ? "" : `![${alt}]`;
    }

    private link(anchor: Element, inner: string): string {
      const target = keptTarget(anchor.getAttribute("href"));
      return this.links && target !== null ? within(inner, (text) => `[${text}](${target})`) : inner;
    }

    /** A node's inline Markdown on one line, as a heading or a table cell holds it. */
    private oneLine(node: Node): string {
      return tidy(this.inlineChildren(node).replace(/\n/g, " "));
    }

    /** The blocks of a container's children, in order: runs of inline content become paragraphs between its block children. */
    blocks(parent: Node): Block[] {
      const blocks: Block[] = [];
      let run = "";
      const flush = () => {
        const paragraph = tidy(run);
        if (paragraph !== "") blocks.push({ text: paragraph });
        run = "";
      };
      for (const child of Array.from(parent.childNodes)) {
        if (isElement(child) && BLOCKS.has(child.localName)) {
          flush();
          blocks.push(...this.block(child));
        } else run += this.inline(child);
      }
      flush();
      return blocks;
    }

    private block(element: Element): Block[] {
      const name = element.localName;
      // What no reader sees stays out wherever it sits, a list's own children included.
      if (SKIPPED.has(name)) return [];
      const heading = /^h([1-6])$/.exec(name);
      if (heading) {
        const text = this.oneLine(element);
        return text === "" ? [] : [{ text: `${"#".repeat(Number(heading[1]))} ${text}` }];
      }
      switch (name) {
        case "ul":
        case "ol":
          return this.list(element);
        case "pre":
          return [this.codeBlock(element)];
        case "blockquote":
          return this.quotation(element);
        case "table":
          return this.table(element);
        case "hr":
          return [{ text: "---" }];
        case "dt": {
          const term = this.oneLine(element);
          return term === "" ? [] : [{ text: `**${term}**` }];
        }
        default:
          return this.blocks(element);
      }
    }

    /** A list's items, each its marker and its blocks, a nested list under the item's text without a blank line. */
    private list(list: Element): Block[] {
      const ordered = list.localName === "ol";
      let number = ordered ? Number.parseInt(list.getAttribute("start") ?? "1", 10) : 0;
      if (!Number.isFinite(number)) number = 1;
      const items: string[] = [];
      let width = 0;
      for (const child of Array.from(list.children)) {
        const blocks = child.localName === "li" ? this.blocks(child) : this.block(child);
        if (blocks.length === 0) continue;
        const body = blocks.map((block, index) => (index === 0 ? "" : block.list ? "\n" : "\n\n") + block.text).join("");
        // A list written straight inside a list, as some pages write one, belongs to the item before it.
        if (child.localName !== "li" && items.length > 0) {
          items.push(`${" ".repeat(width)}${hanging(body, width)}`);
          continue;
        }
        const marker = ordered ? `${number++}. ` : "- ";
        width = marker.length;
        items.push(`${marker}${hanging(body, width)}`);
      }
      return items.length === 0 ? [] : [{ text: items.join("\n"), list: true }];
    }

    private codeBlock(pre: Element): Block {
      const code = preText(pre).replace(/^\n/, "").replace(/\s+$/, "");
      const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
      return { text: `${fence}${languageOf(pre)}\n${code}\n${fence}` };
    }

    private quotation(quote: Element): Block[] {
      const inner = this.blocks(quote)
        .map((block) => block.text)
        .join("\n\n");
      if (inner === "") return [];
      const quoted = inner.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
      return [{ text: quoted.join("\n") }];
    }

    /** A table as GitHub's Markdown writes one: its caption before it, its first row the header, every row as wide as the widest. */
    private table(table: Element): Block[] {
      const caption = table.querySelector(":scope > caption");
      const rows = Array.from(table.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr"), (row) =>
        Array.from(row.children)
          .filter((cell) => cell.localName === "td" || cell.localName === "th")
          .map((cell) => this.oneLine(cell).replace(/\|/g, "\\|")),
      );
      const width = Math.max(0, ...rows.map((row) => row.length));
      const blocks: Block[] = caption ? this.blocks(caption) : [];
      if (width === 0) return blocks;
      const line = (cells: readonly string[]): string => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
      const [header = [], ...body] = rows;
      const lines = [line(header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)];
      return [...blocks, { text: lines.join("\n") }];
    }
  }

  /** Two headings' texts compared as a reader compares them: white space collapsed, case ignored. */
  const sameText = (a: string, b: string): boolean => collapse(a).trim().toLowerCase() === collapse(b).trim().toLowerCase();

  /**
   * The article as Markdown: its title as the first heading (unless it has
   * none, or its content already opens with a heading of that text), then its
   * content, link targets kept only when `links` asks for them.
   */
  const articleMarkdown = (article: ReaderArticle, options: MarkdownOptions = {}): string => {
    const blocks = new Converter(options.links ?? false).blocks(article.content).map((block) => block.text);
    const title = collapse(article.title ?? "").trim();
    const opensWithTitle = /^#{1,6} /.test(blocks[0] ?? "") && sameText((blocks[0] as string).replace(/^#{1,6} /, ""), title);
    if (title !== "" && !opensWithTitle) blocks.unshift(`# ${title}`);
    return blocks.join("\n\n");
  };

  return { articleMarkdown };
}

export const { articleMarkdown } = markdownModule();
