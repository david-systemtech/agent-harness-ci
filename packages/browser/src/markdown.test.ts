import { describe, expect, it } from "vitest";
import { pageOf } from "../test/pages.js";
import { articleMarkdown, type ReaderArticle } from "./index.js";

/** A Readability article: its title, and its content as the reader hands it over, an element wrapping the article's page. */
const article = (content: string, title: string | null = "Keeping backups honest"): ReaderArticle => ({
  title,
  content: pageOf(`<!doctype html><body><div id="readability-page-1" class="page">${content}</div></body>`).getElementById("readability-page-1") as Element,
});

describe("Markdown from a Readability article", () => {
  it("opens with the title and keeps the headings, paragraphs and emphasis", () => {
    const markdown = articleMarkdown(
      article(`<div><h2>The drill</h2><p>A backup nobody has <em>restored</em> is a <strong> hope </strong>.</p><h3>Using <code>restic</code></h3><p>Pick a
      snapshot,   then restore it.</p></div>`),
    );
    expect(markdown).toBe(
      ["# Keeping backups honest", "## The drill", "A backup nobody has *restored* is a **hope** .", "### Using `restic`", "Pick a snapshot, then restore it."].join("\n\n"),
    );
  });

  it("leaves the title out where there is none, or where the article already opens with it", () => {
    expect(articleMarkdown(article("<p>Only a paragraph.</p>", null))).toBe("Only a paragraph.");
    expect(articleMarkdown(article("<h1>Keeping  backups honest</h1><p>Text.</p>"))).toBe("# Keeping backups honest\n\nText.");
  });

  it("keeps lists: bulleted, numbered from their start, nested, and an item of more than one paragraph", () => {
    const markdown = articleMarkdown(
      article(`<ul><li>One</li><li>Two<ul><li>Two a</li><li>Two b</li></ul></li></ul><ol start="3"><li>Third</li><li><p>Fourth</p><p>More about it.</p></li></ol>`, null),
    );
    expect(markdown).toBe(["- One\n- Two\n  - Two a\n  - Two b", "3. Third\n4. Fourth\n\n   More about it."].join("\n\n"));
  });

  it("puts a list written straight inside a list under the item before it", () => {
    expect(articleMarkdown(article(`<ol><li>First</li><ul><li>Under it</li></ul><li>Second</li></ol>`, null))).toBe("1. First\n   - Under it\n2. Second");
  });

  it("leaves out a script, a style or a noscript written straight inside a list", () => {
    const content = `<ol><li>First</li><script>var tracked = 1;</script><style>li { color: red; }</style><noscript>Turn on scripts.</noscript><li>Second</li></ol>`;
    expect(articleMarkdown(article(content, null))).toBe("1. First\n2. Second");
  });

  it("keeps tables, the first row as the header, a pipe in a cell escaped and a short row filled out", () => {
    const markdown = articleMarkdown(
      article(
        `<table><caption>What to record</caption><thead><tr><th>Field</th><th>Why</th></tr></thead><tbody><tr><td>Age</td><td>Retention <a href="https://example.com/r">matters</a> | a lot</td></tr><tr><td>Time</td></tr></tbody></table>`,
        null,
      ),
    );
    expect(markdown).toBe(["What to record", "| Field | Why |\n| --- | --- |\n| Age | Retention matters \\| a lot |\n| Time |  |"].join("\n\n"));
  });

  it("keeps code: a block fenced with its language and its lines as written, and inline code, fenced past the backticks it holds", () => {
    const markdown = articleMarkdown(
      article(
        `<pre><code class="language-sh">restic restore latest \\
  --target /tmp/drill</code></pre><p>Run <code>restic check</code> first, and mind <code>\`ticks\`</code>.</p><pre>a fence \`\`\` inside<br>and a break</pre>`,
        null,
      ),
    );
    expect(markdown).toBe(
      [
        "```sh\nrestic restore latest \\\n  --target /tmp/drill\n```",
        "Run `restic check` first, and mind `` `ticks` ``.",
        "````\na fence ``` inside\nand a break\n````",
      ].join("\n\n"),
    );
  });

  it("drops link targets and keeps the link text, an image kept by its alt text", () => {
    const content = `<p>Read <a href="https://example.com/guide">the guide</a> and <a href="https://example.com/b"><img src="https://example.com/i.png" alt="a diagram"></a>.</p><figure><img src="https://example.com/chart.png" alt="Chart"><figcaption>Monthly restore times.</figcaption></figure>`;
    expect(articleMarkdown(article(content, null))).toBe("Read the guide and ![a diagram].\n\n![Chart]\n\nMonthly restore times.");
  });

  it("keeps link targets when links are asked for, a script's link still its text alone", () => {
    const content = `<p>Read <a href="https://example.com/guide">the guide</a>, <a href="https://example.com/b"><img src="https://example.com/i.png" alt="a diagram"></a> and <a href="javascript:void(0)">this</a>.</p>`;
    expect(articleMarkdown(article(content, null), { links: true })).toBe(
      "Read [the guide](https://example.com/guide), [![a diagram](https://example.com/i.png)](https://example.com/b) and this.",
    );
  });

  it("keeps quotations, rules and line breaks, and leaves out what no reader sees", () => {
    const content = `<blockquote><p>Quoted.</p><p>Second.</p></blockquote><hr><p>Line one<br>Line   two</p><script>track()</script><style>p{}</style><p>End.</p>`;
    expect(articleMarkdown(article(content, null))).toBe("> Quoted.\n>\n> Second.\n\n---\n\nLine one\nLine two\n\nEnd.");
  });
});
