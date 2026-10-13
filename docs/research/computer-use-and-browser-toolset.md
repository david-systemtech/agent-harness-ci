# Research: computer use and the browser toolset

Issue #2123, written 2026-10-13 on main at 6db851b. This document answers four questions:

- Can the Claude adapter offer Anthropic's API-native browser and computer toolsets?
- How does the harness's browser tool surface compare with the browser use tool, member by member?
- How should the harness offer computer use?
- In what order should it be built?

It ends with questions for David. It is research and design only. No product code changes here, and no decision is taken: each recommendation waits for an answer in section 5, an ADR, and a spec.

The versions read:

- `@anthropic-ai/claude-agent-sdk` 0.3.289, which bundles Claude Code 2.1.289. This is the pin in `packages/environment/package.json`.
- `@anthropic-ai/sdk` 0.128.0 as installed. The npm registry's latest is 0.133.0.
- Anthropic's platform documentation as served on 2026-10-13.
- The Claude Code and Agent SDK changelogs on GitHub's `main`, read the same day.

Sources are listed at the end.

## Executive summary

- **The native toolsets cannot be offered through the Claude adapter today.**
  - What they are: `browser_toolset_20260801` and `computer_toolset_20260801` are client toolsets of the Messages API. They are generally available and need no beta header; only the SDK classes that drive them are beta.
  - Why the adapter cannot reach them: the adapter drives Claude Code through the Agent SDK, and the SDK's `Options` has no way to put a toolset entry into the request. `tools` names built-in tools only. `betas` accepts only `context-1m-2025-08-07`. Custom tools reach the model only as MCP tools, which are always named `mcp__<server>__<tool>`.
  - Claude Code's own browser and computer features are MCP servers too: `claude-in-chrome` (Anthropic's Chrome extension, which needs a claude.ai login) and `computer-use` (macOS only, interactive sessions only, not `-p`). They are neither the API toolsets nor the harness's tools.
- **Keep the harness's browser stack, and reshape what the model sees so its trained prior transfers.**
  - What already does better than the reference drivers: the per-frame denylist with its hand-off to the person, the relay through the client, the Readability reader, challenge hand-off, secret redaction, the untrusted-content frame, and the three browser kinds. The quickstart CDP driver implements five members and the production Stagehand driver none of these policies.
  - What to change: rename and reshape the 16 `browser_*` tools onto the toolset's member names and input shapes (`navigate`, `left_click` with a ref-or-coordinate `target`, `read_page`, `get_page_text`, `key`, tabs, and so on). Close the gaps: `key`, hover, drag, the other clicks, `zoom`, `find`, tabs, a `browser_state` footer, a batch tool with the halt rule, and downloads and uploads.
  - Two choices keep later moves open. Map bare member names to our tools with the SDK's `toolAliases`. Write the driver so it can later sit behind `BetaAbstractBrowserToolset20260801` in a Messages API adapter.
- **Computer use goes in two steps.**
  - First, a contained desktop: a Linux virtual display in a container (a `desktop` compose profile beside the existing `browser` one) or a VM. The environment drives it over VNC from pure TypeScript, as Anthropic's own computer-toolset quickstart does. It needs no native code, is safe enough for unattended runs, and works from every environment kind, the container included.
  - Second, the person's live desktop: the environment's own process drives it, since the installed service already runs in the person's logged-in session on all three platforms. It uses native screenshot and input libraries in a child process.
  - The live desktop is attended only. Each session must get the person's grant before its first action, and that grant is never automatically approved, bypass included. The toolset's typing members ask in every mode below bypass. A new denylist section of desktop apps is judged on the app under each action. Windows comes first, then macOS, then Linux on X11 (Wayland is refused with a reason).
  - The tools take the computer toolset's member names, as `mcp__computer__<member>`.
- **Screenshots must be kept so people can see them.** Today the event log records a tool image as its media type and size only (`recordedImage`, #540), so the GUI draws no browser screenshot at all. Computer use is unwatchable without a retained-image store, so that store is a prerequisite.
- **A Messages API adapter is the only route to the native toolsets.** It would run the loop in the environment with `@anthropic-ai/sdk` 0.132.0 or later and plug the same drivers into the toolset classes. It needs an API key, which ADR 0018 defers to milestone 4 or 5, and it would have to rebuild everything Claude Code supplies. This document records it as a later option, not a step.

## 1. Can the Claude adapter offer the native toolsets?

### What the toolsets are

The two toolsets are entries in the Messages API's `tools` array: `{"type": "browser_toolset_20260801"}` and `{"type": "computer_toolset_20260801"}`. An entry has no `name`. It takes optional `configs` (per member: `enabled`, `defer_loading`), `cache_control` and `allowed_callers`.

The model calls a member as a `tool_use` whose `name` is the member and whose `toolset_name` is `browser` or `computer`. A result echoes `toolset_name`. A browser result may hold only `text`, `image` and `browser_state` blocks. ([tool-reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference), [browser-use-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool))

Facts about availability:

- Both toolsets are generally available on the Claude API and Google Cloud, with no beta header.
- Claude 5.5 and later models accept computer use only through `computer_toolset_20260801`, and return an error for `computer_20251124` and `computer_20250124` there.
- The tool reference says: "Client toolsets are Messages API tools. They aren't currently available as agent tools in Claude Managed Agents."
- Server-side prompt-injection classifiers run on toolset requests automatically.

The SDK side, which is beta:

- The classes are `BetaAbstractBrowserToolset20260801` and `BetaAbstractComputerToolset20260801`, from `@anthropic-ai/sdk/helpers/beta/toolsets`. They first ship in `@anthropic-ai/sdk` 0.132.0 (2026-10-07). The installed 0.128.0 has the request types but not the classes.
- A driver overrides one protected method per member.
- The SDK runs a URL policy, a file policy and a `confirm` callback before each call. It applies the batch halt rule. It asks the driver for a `browser_state` after every call.
- It plugs into the beta tool runner (`client.beta.messages.toolRunner`), which is Messages API only. ([browser-use-sdk](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk), [tool-runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner), the SDK's `browser-toolset.md` and `computer-toolset.md`)

### What the Agent SDK can pass

The Claude adapter (`packages/environment/src/adapters/claude/options.ts`, `buildRunOptions`) runs every turn through the Agent SDK's `query`, which spawns Claude Code. Claude Code builds the Messages API request itself. The Agent SDK 0.3.289 `Options` (`sdk.d.ts`) offers these routes to the request's tools:

- `tools`: "Specify the base set of available built-in tools": a list of built-in names, `[]`, or the `claude_code` preset. It has no shape for a server or client tool definition.
- `mcpServers`: stdio, SSE, HTTP, `claudeai-proxy`, or an in-process SDK server. Every tool from one reaches the model as `mcp__<server>__<tool>`.
- `allowedTools` and `disallowedTools`: permission rules over tool names.
- `betas?: SdkBeta[]`, where `SdkBeta = 'context-1m-2025-08-07'`. This is the only accepted value.
- `extraArgs`: CLI flags passed to Claude Code. No Claude Code flag adds an API tool definition.
- `toolAliases` (new in this SDK): "When the model emits a `tool_use` whose name is a key in this map, the tool execution path resolves the mapped name instead". This is useful below.

Searches turned up no toolset support:

- The installed SDK's JavaScript and types contain none of `computer_20`, `browser_20`, `browser_toolset` or `computer_toolset`.
- The bundled Claude Code binary contains no toolset type string either.
- The Agent SDK documentation describes custom tools only as MCP tools, and says to "call the Messages API when you need those parameters directly".
- The Agent SDK changelog has no toolset entry.

So a toolset entry cannot reach the request. Claude Code runs its own loop and takes only its built-in tools and MCP servers.

### What Claude Code has instead

**Claude in Chrome** (`--chrome`, generally available since Claude Code 2.1.198).

- How it is built: a built-in stdio MCP server, `claude-in-chrome`, which Claude Code spawns as `claude --claude-in-chrome-mcp`. It talks through a native messaging host to Anthropic's Chrome Web Store extension, signed in to the same claude.ai organisation, over `bridge.claudeusercontent.com`.
- Its tools in 2.1.289's binary: `navigate`, `read_page`, `find`, `form_input`, `computer` (one tool with an action field, as the older computer tool versions had), `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`, `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `upload_image`, `file_upload`, `gif_creator`, `resize_window`, `shortcuts_list`, `shortcuts_execute`, `browser_batch`, `switch_browser`, `list_connected_browsers` and `select_browser`. The model sees them as `mcp__claude-in-chrome__<tool>`.
- It needs a claude.ai login: "If you authenticate with an API key or a long-lived token from `claude setup-token`, Claude Code keeps Chrome integration off, even when you pass `--chrome`".
- A project's settings cannot turn it on (2.1.290).
- Agent SDK 0.3.290's changelog fixes "failed Claude in Chrome tool calls dropping the result's `_meta`". So SDK-driven sessions can run it, presumably with `extraArgs: { chrome: null }`. I did not try that here.

**Computer use**:

- A built-in MCP server `computer-use`, off until enabled in `/mcp`.
- In the CLI it is "a research preview on macOS that requires a Pro or Max plan" and "requires an interactive session, so it is not available in non-interactive mode with the `-p` flag". It drives a macOS-only native module (`@ant/computer-use-swift`).
- An Agent SDK run is not interactive, so it cannot reach this server.
- Claude's desktop app has computer use on macOS and Windows. That is another product.

Two pieces of evidence about the model's prior:

- Claude in Chrome's tool names are the browser toolset's member names, or their immediate forebears (`navigate`, `read_page`, `find`, `form_input`, `get_page_text`).
- Claude Code 2.1.284 improved "the 'No such tool available' error for Claude in Chrome tools called without their prefix". The model emits bare member names often enough to need a fix.

Together these show what the model is trained against: the member names and input shapes, not `mcp__browser__browser_click` with a CSS selector.

### What would reach the native toolsets

Four routes, from cheapest to most expensive:

1. **A bridge by name through MCP (recommended now).**
   - What it is: expose the harness's drivers as MCP tools named after the toolset's members, with the members' input schemas, so the model sees `mcp__browser__navigate`, `mcp__browser__left_click` with `{target: {type: "ref", ref}}`, and so on.
   - The prefix cannot be avoided, but Anthropic's own browser for Claude Code is built exactly this way.
   - Set `toolAliases` (`navigate` to `mcp__browser__navigate`, and so on) so a bare member name the model emits still lands. It must never alias a name a built-in tool holds.
   - What it keeps: every harness policy, since the call still passes the gate (`canUseTool`), the denylist, the relay and the framing.
   - What it gives up: the server-side injection classifiers and the API's rendering of `browser_state`, which the tool server writes as text instead.
2. **Claude Code's roadmap.** If a later Agent SDK takes a client toolset, the adapter could pass one. The SDK would then call a driver in the environment's process, and the drivers below are written to that contract so the step stays small. Nothing published says this is planned. Watch the Agent SDK changelog at each SDK bump (#1724's pin process).
3. **A Messages API adapter (ADR 0015's contract).**
   - What it is: a `claude-api` adapter running its own loop in the environment with `@anthropic-ai/sdk` 0.132.0 or later and the tool runner. The browser driver sits behind `BetaAbstractBrowserToolset20260801`:
     - its URL policy is the page policy's `standingOf` plus the gate's `browse` check;
     - `confirm` is the permission broker;
     - the file policy is a `BetaNodeFilePolicy` on the session's folders;
     - `browserState` is the driver's tab book.
   - The computer driver sits behind `BetaAbstractComputerToolset20260801`.
   - What it gains: the native members, the server's rendering, and the classifiers.
   - What it costs:
     - It needs an API key, billed per token. ADR 0018 rejected a pasted key for milestone 1 and wants one "much later (milestone 4 or 5)".
     - It runs only on the Claude API and Google Cloud.
     - It has to rebuild what Claude Code provides: file and shell tools, the sandbox, compaction, skills, the session store, resume, fork and rewind. That is the local loop's scope in ADR 0015 (milestone 2). A Messages API flavour of that loop is the natural home if it is ever wanted.
4. **Claude Code's built-ins.** Claude in Chrome through `extraArgs` would hand the person's signed-in Chrome to Anthropic's extension. Its calls would reach the gate only as opaque `other` calls. It has no per-frame denylist, no relay, no headless browser, no reader, and it needs a claude.ai login. Computer use is not reachable at all. Not recommended, though Claude in Chrome could later be a fourth browser kind for people who already use it (question 1).

## 2. The browser: member by member

The harness's surface, from `packages/environment/src/browser/page-tools.ts` and `tool-server.ts`:

- One in-process server, `browser`, which always offers `web_read`.
- When the run's resolved browser is a Chrome, the headless browser or the dock, it adds `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_read`, `browser_screenshot`, `browser_click_at`, `browser_scroll`, `browser_wait_for` and `browser_close`.
- It adds the deep verbs `browser_console`, `browser_network`, `browser_cookies`, `browser_storage` and `browser_evaluate` where the kind has them.
- Elements are addressed by snapshot refs (`e12`, `f1e5`), a CSS selector, or screenshot pixels.
- There is one page per session (the page key), no tab model, and no hover, drag, key, zoom, upload or download.

The toolset's members come from the browser use tool page. It has 27 members by default; `javascript_exec`, `file_upload`, `read_console` and `read_network` are off until enabled.

| Toolset member | Toolset semantics | Harness today | Verdict |
|---|---|---|---|
| `navigate(url, tab_id?)` | http(s), or `"back"`, `"forward"`, `"reload"`. No scheme means https. Other schemes refused | `browser_navigate(address)`; `browser_open(address?, browser?)` opens or returns the session's page | **Different.** No back, forward or reload. The open/navigate split has no counterpart. Rename to `navigate`, add the three words, and fold `browser_open` into it. The several-Chromes choice moves to its own tool (as Claude in Chrome's `select_browser`) |
| `screenshot(tab_id?)` | Viewport image at device scale 1. The model infers the viewport from it | `browser_screenshot()`: JPEG q70 of a 1280 by 800 viewport, about 1,334 visual tokens | **Present.** Rename only |
| `zoom(region [x0,y0,x1,y1])` | Cropped, upscaled image of a region | none | **Missing.** Add it: `Page.captureScreenshot` with a `clip` and a scale |
| `left_click(target, modifiers?)` | `target` is `{type:"ref",ref}` or `{type:"coordinate",x,y}`. Modifiers like `"ctrl+shift"` | `browser_click(ref \| selector)` and `browser_click_at(x, y)`. No modifiers | **Different.** Merge into `left_click` with the toolset's `target` and `modifiers`. Drop `selector` from the model's surface (question 9) |
| `right_click`, `middle_click`, `double_click`, `triple_click` | Same inputs | none | **Missing.** Add them, with the same dispatch and other buttons and click counts |
| `hover(target)` | Move the pointer to a target | none | **Missing.** Add it (menus and tooltips) |
| `left_click_drag(from, target)`, `left_mouse_down`, `left_mouse_up`, `mouse_move` | Coordinate targets | none | **Missing.** Add them (sliders, canvases, drag and drop) |
| `scroll(target, scroll_direction, scroll_amount?)` | Wheel at a coordinate, 1 to 10 notches, preset 3 | `browser_scroll(direction, amount)` in viewports (at most 100) at the viewport's centre, or `ref` | **Different.** Take the toolset's inputs (a coordinate, so an inner scroller can be scrolled) |
| `scroll_to(target: ref)` | Scroll a ref into view | `browser_scroll(ref)` | **Present, different name.** Split it out |
| `type(text)` | Types into the focused element | `browser_type(ref \| selector, text)`: selects the field, inserts the text as one input event, replacing what was there | **Different.** Our verb is closer to `form_input`. Make `type` insert at the focus, and make `form_input` our replace-the-value verb |
| `form_input(target: ref, value)` | Sets a field's value: string, number or boolean (selects and checkboxes) | `browser_type` for text only | **Partly present.** Add selects, checkboxes and radios |
| `key(text, repeat?)` | One key, a `+` chord, or a space-separated sequence, repeated 1 to 100 times | none (Delete is pressed internally for an empty `browser_type`) | **Missing, and the largest gap.** The model cannot press Enter to submit, Escape to close, or Tab to move. Add it with `Input.dispatchKeyEvent` |
| `hold_key(text, duration ≤30 s)` | Hold a key | none | **Missing.** Add it (games and canvases; low priority) |
| `wait(duration ≤30 s)` | Sleep | `browser_wait_for(ms \| text \| ref, timeoutMs)`, at most 30 s | **Better here.** Keep waiting for text or a ref as optional extras on `wait` |
| `read_page(filter?, depth?, ref?)` | Accessibility tree with `[ref_N]`. Filter: none (visible), `interactive`, `all`. Depth preset 15. Capped at 50,000 characters | `browser_snapshot(filter interactive\|all, depth, ref, maxChars 30,000 up to 200,000)`. Playwright's aria snapshot across frames and shadow roots, refs `e12`/`f1e5`. Actions carry a 12,000-character snapshot | **Present and stronger** (frames stitched, shadow roots, redaction, cut rules). Rename to `read_page`. Add the toolset's visible-only preset as a third filter and make it the preset. Keep our ref spelling, since refs are opaque strings |
| `find(query)` | Natural-language search, up to 20 matches in `read_page` form | none (the browser spec puts it in milestone 2) | **Missing.** Add it as a lexical match over the snapshot's roles, names and text, returning refs, as Stagehand's `lexical` find mode does. A model-backed find is not needed |
| `get_page_text()` | The page's text | `browser_read(offset, links)`: Readability 0.6.0 to Markdown, paged at 24,000 characters, falling back to the snapshot | **Better here.** Rename to `get_page_text` and keep `offset` and `links` as optional extras |
| `new_tab`, `list_tabs`, `switch_tab(tab_id)`, `close_tab(tab_id)` | Tab inventory. Every member takes `tab_id?` | none. One page per session. `browser_close` lets go of it | **Missing.** Add a small tab book per session (below). `browser_close` becomes `close_tab` |
| `read_console()` | Entries since the last read | `browser_console()` | **Present.** Rename. Keep the dev-site rule on a Chrome |
| `read_network()` | Requests since the last read | `browser_network(failedOnly)` | **Present.** Rename. Keep `failedOnly` |
| `javascript_exec(text)` | Value of the last expression. Off by default and gated by `confirm` | `browser_evaluate(expression)`, only on dev sites in a Chrome unless widened | **Present, with a stronger policy.** Rename, keep the policy, and take `text` as its argument |
| `file_upload(target, paths?, document_ids?)` | Off by default. Gated by `confirm`. Paths resolved by the file policy | none | **Missing.** Add it, off by default (question 8) |
| Downloads | No member. `browser_state` reports `download_started`, `download_completed` and `download_failed` | none (a load with no document is all the driver sees) | **Missing.** Report downloads in the state footer. Allow them only into a per-session folder in the headless browser (question 8) |
| Batch failure rule | Calls in one turn run in order. After the first failure each later call answers `is_error` with "Not executed: an earlier action in this turn failed." | No rule. Each MCP call stands alone, and the tool server cannot see turn boundaries | **Missing.** Add a `batch` tool that takes a list of member calls and applies the rule. Claude in Chrome's `browser_batch` shows the model knows the shape |
| `browser_state` | After each call: full tab inventory (id, title, url, active) plus changes (`tab_opened`, downloads; the SDK adds `navigation_refused` and `dialog_dismissed`) | A line "The page is at <address>". Notices for dialogs accepted or dismissed. Refusals that name the denylist entry | **Partly present.** Append a "Tab Context" footer, written the way the API renders it, to every successful result |

What the harness does that neither the toolset nor the reference drivers do:

- **The denylist on every frame.** The browser section is judged on every frame's arrival, in all three browsers. A sub-frame into a listed domain refuses the page. A top-level navigation the agent did not name is held, then put to the person as a `denylist` prompt (or denied on an unattended run), with a one-time allowance after an allow. By contrast:
  - The SDK's URL policy sees only the URL the model wrote for `navigate`.
  - The SDK's safety section leaves request interception and egress to the driver ("Steps 2, 3, and 6 are up to your driver and your deployment").
  - The quickstart driver intercepts nothing.
  - Stagehand's domain lists are enforced per request, but its own README says they do not cover WebSocket handshakes.
- **The dev-site policy.** In the person's Chrome, cookie values, storage and evaluation only work on sites the person develops, unless widened.
- **Challenge hand-off.** Captchas and bot checks are detected from markers, named, and handed to the person, never retried (#292).
- **The reader and `web_read`.** Readability Markdown paged to the end, and a fetch reader for pages and PDFs that need no browser.
- **Model-boundary hygiene.** Every page-derived result is framed between random boundary tokens. Secret fields and token-shaped strings are redacted, then the result passes the scrub registry.
- **The relay through the client.** It reaches a Chrome paired with the person's own machine from a run on any environment (ADR 0014). The toolset's remote-browser section covers only a browser the SDK's own process connects to.
- **Three kinds, one driver**, for the person's Chrome, the headless browser and the dock. **The headless tab rules** (idle close, at most two contexts, the heap watchdog, empty exit).
- **Isolated worlds without `Runtime.enable`.** Debugging domains come on lazily, so the person's Chrome looks less automated.

### Recommendations

What to add, in priority order:

1. `key`. Without it no form can be submitted by Enter and no dialog closed by Escape.
2. The other clicks, with modifiers, plus `hover` and drag.
3. A tab book and the `browser_state` footer.
4. `find`.
5. `zoom`.
6. `form_input` for selects and checkboxes.
7. The `batch` tool with the halt rule.
8. Downloads in the headless browser, reported in the footer.
9. `file_upload`, off by default.

What to rename and reshape:

- Every tool takes its member's name and input shape under `mcp__browser__`, with our extras as optional fields: `offset` and `links` on `get_page_text`, `text` and `ref` on `wait`, `failedOnly` on `read_network`, `snapshot: false` on actions.
- `browser_cookies` and `browser_storage` have no member and become `read_cookies` and `read_storage`.
- `web_read` keeps its name.
- `toolAliases` maps the bare member names to ours.
- The prefix check in `permissions/tool-decisions.ts` (`mcp__browser__browser_`, which defers a browsing decision until the frame checks finish) and the browser checklist change with the names.
- Keep the actions' trailing interactive snapshot as it is (Playwright's MCP server and Hermes do the same). The toolset's members answer only a short acknowledgement.

What to keep:

- The page-driver contract and its never-throw refusals, the page key, the denylist and dev-site rules, the reader, redaction, framing, challenge hand-off, the relay and the tab rules.
- The driver stays written once against CDP. Each new verb is one method in `packages/browser/src/driver/` and one schema in `contracts`.

**The tab book.** A session's page key gains a tab id. It is still opaque, and no verb may name another session's tab. A popup (`window.open`, `target=_blank`) is adopted as a tab and reported as `tab_opened`. Per kind:

- In a Chrome, the tabs live in the session's tab group, which the extension already keeps.
- In the headless browser, they are targets in the session's context, counted by a tab cap in `browser.headless.limits` (a chosen default of 5).
- In the dock there is one tab, since it is one web view.

`close_tab` keeps today's rule: a tab in the person's own browser is let go of, never closed for them.

## 3. Computer use

### The computer toolset and what a driver supplies

`computer_toolset_20260801` has 17 members, all enabled by default:

- `screenshot`, `cursor_position`, `left_mouse_down` and `left_mouse_up`, which take no input.
- `zoom(region)`.
- `left_click`, `right_click`, `middle_click`, `double_click` and `triple_click`, each with an optional `coordinate` and an optional `text` of modifier keys (`shift`, `ctrl`, `alt`, `super`, joined by `+`).
- `left_click_drag(start_coordinate, coordinate, text?)`.
- `mouse_move(coordinate)`.
- `scroll(scroll_direction, scroll_amount, coordinate?, text?)`.
- `type(text)`.
- `key(text, repeat?)`.
- `hold_key(text, duration ≤ 300 s)`.
- `wait(duration ≤ 300 s)`.

The entry rejects `display_width_px`, `display_height_px` and `display_number`: "coordinates are always in the pixel space of the screenshots you return". The SDK's default `confirm` set for the computer toolset is `type`, `key` and `hold_key`. A refusal reads "The user did not grant permission to run '<member>'. Do not retry it unless the user asks you to." The batch halt text is "Not executed: an earlier computer action in this turn failed."

Images:

- The API does not downscale them.
- Toolset models accept up to 2,576 pixels on the long edge and 4,784 visual tokens (about 3.75 megapixels).
- After 20 images in a request, each must be at most 2,000 pixels a side.
- The documentation recommends 1024 by 768 or 1280 by 720 for desktop tasks and nothing above 1920 by 1080.
- A screenshot costs about 1,000 to 1,800 tokens. The toolset's definitions cost about 4,500 input tokens.

The SDK's computer guidance:

- Isolate the desktop.
- Gate actions with `confirm`.
- Keep terminals and launchers off the desktop.
- Refuse out-of-bounds input rather than clamping it.
- Treat the screen as untrusted.
- "The SDK never reads or resizes an image": scaling is the driver's job.

**The harness's desktop driver contract** mirrors the members as the page-driver contract mirrors the browser verbs:

- Every member resolves to a value or a refusal sentence, never an exception.
- Every coordinate is in the pixel space of the latest screenshot.
- A driver states its display (logical size, the scale from capture to model pixels, the origin on the virtual desktop) and its abilities.

It lives in `contracts` as `desktop-driver.ts`. The tools are an in-process server `computer`, so the model sees `mcp__computer__screenshot`, `mcp__computer__left_click` and so on, with the members' input schemas. They take the same `toolAliases` treatment, with the same care not to collide with built-in names. A driver also supplies:

- The app under a point and the frontmost app, for the desktop denylist below.
- A stop signal the person can raise.
- A lock, so only one session drives a desktop at a time.

### Where the desktop lives and who drives it

| Environment kind | Desktop | Driving process |
|---|---|---|
| Container (the published image, compose) | None of its own | The environment, over VNC, to a **contained desktop**. This is a `desktop` compose profile under an opt-in profile, as the `browser` one is: Xvfb at 1280 by 800, a light window manager, x11vnc on loopback, a non-root user, a memory limit, and a digest-pinned image. Anthropic's computer-use reference image follows the same pattern |
| Linux machine with a desktop | The person's X11 or Wayland session, or a virtual display the environment starts | **Contained**: the environment starts Xvfb with a VNC server as the person, beside their session, and drives it over VNC. **Live**: the environment's helper process on X11 (XTest and XGetImage). Wayland is refused with a reason (below) |
| Windows desktop | The person's interactive session | **Live**: the environment's helper process. The installed service is a Task Scheduler task with a logon trigger and `<LogonType>InteractiveToken</LogonType>` (`packages/cli/src/service/task-scheduler.ts`), so it runs in the person's session on their desktop. **Contained**: a VM (Hyper-V or Windows Sandbox) with a VNC server, driven over VNC |
| macOS laptop | The person's Aqua session | **Live**: the environment's helper process. The service is a LaunchAgent in `~/Library/LaunchAgents` (`launchd.ts`), loaded into the person's GUI session at login. **Contained**: a macOS or Linux VM (Virtualization.framework) with VNC, or Screen Sharing's VNC on a second user's session |
| A run on another environment that should drive my machine | My machine's desktop | **The relay**, as the browser's: the run's environment appends a `client.call` of a new kind, `desktop.local`. My client asks my local environment to perform the member and answers. The 8 MiB answer cap holds a screenshot |

**Why the environment and not the desktop shell.**

- The shell runs only while its window is open, and a run belongs to the environment (ADR 0006, ADR 0015).
- Electron can capture the screen (`desktopCapturer`) but cannot synthesise input outside its own windows, so the shell would need the same native code anyway.
- On macOS, the desktop build is signed ad hoc (`packages/desktop/scripts/desktop-build/config.ts`, milestone 1 ships unsigned builds, #359). macOS keys Accessibility and Screen Recording grants to the code signature, so an ad hoc identity changes with every update and loses its grants.
- The environment's Node is the release tarball's, left with Node's own signature on purpose (#1724). That identity is stable, though it is "node" in System Settings rather than the product (risk 4).

**Why VNC for contained desktops.**

- The RFB protocol gives screenshots (framebuffer updates) and input (pointer and key events) in pure TypeScript, with no native dependency in the environment.
- The same driver serves a container, a Linux virtual display, a VM, and macOS Screen Sharing.
- Anthropic's computer-toolset quickstart ships exactly this driver (`vnc-computer.ts`), with unscaled capture capped at 1920 by 1200 and off-screen points refused.

**Why a helper process for the live desktop.** The native libraries load in a child process the environment spawns and speaks to over stdio, not in the environment itself:

- A crash in native code cannot take the environment down.
- The libraries can be optional dependencies, as `node-pty` is, so a machine where they cannot load still runs everything else and answers "computer use is unavailable here" with the reason.
- The helper is the one identity that later needs signing on macOS.

### Libraries and permission prompts per platform

| Platform | Screenshots | Input | Prompts and limits |
|---|---|---|---|
| Windows | `node-screenshots` 0.2.8 (Apache-2.0, N-API prebuilds for win32 x64/arm64; DXGI or GDI through xcap) | `SendInput` through `robotjs` 0.9.1 or `@jitsi/robotjs` 0.6.24 (MIT, N-API prebuilds) | **No consent prompt.** `SendInput` "is subject to UIPI. Applications are permitted to inject input only into applications that are at an equal or lesser integrity level", and "neither GetLastError nor the return value will indicate the failure was caused by UIPI blocking". The service runs at `LeastPrivilege`, so elevated windows and the UAC secure desktop are unreachable. The helper must check the target window's integrity level and say so rather than click into nothing. A locked workstation answers no capture and no input. The helper must be per-monitor DPI aware (v2) or Windows virtualises its coordinates |
| macOS | ScreenCaptureKit, or `node-screenshots` on CoreGraphics | `CGEventPost` through `robotjs` | **Screen Recording** and **Accessibility**, granted in System Settings to the process macOS sees (the bundled Node). A restart of that process may be needed after granting Screen Recording. macOS 15 re-asks about screen recording monthly ("Allow For One Month"). Screenshots are in pixels (Retina 2x) and CGEvent coordinates in points, so divide by the backing scale |
| Linux, X11 | `XGetImage` (`node-screenshots`) | XTest (`robotjs`) | No prompt. Any client of the X display can do both, which is the risk. A `systemd --user` service lacks `DISPLAY` unless the session imports it (`systemctl --user import-environment DISPLAY XAUTHORITY`), so the environment must find the display or say what to run |
| Linux, Wayland | xdg-desktop-portal ScreenCast (PipeWire) | portal RemoteDesktop (libei on GNOME 46+ and KDE 6.1+) | A consent dialog per session, with a restore token when the person allows persistence (`persist_mode` 2). A locked session refuses and may spend the token. `ydotool` needs `/dev/uinput` (root or the `input` group), which ADR 0006's never-root rule excludes. **Refused in the first phases** with a reason pointing at the contained desktop |

Avoid `nut.js`:

- Its prebuilt packages are only for subscribers ("Pre-built packages are available for subscription plans").
- `@nut-tree/nut-js` is gone from npm.
- The `@nut-tree-fork` packages were last published in March 2025.

`robotjs` was unmaintained from 2019 and has published again since March 2026 with N-API prebuilds. It needs a spike before it is trusted (Not verified).

### Display scaling and coordinate mapping

The driver captures one display at its physical pixels and downsamples to a model image whose long edge is at most a setting (`desktop.screenshot.longEdge`, a chosen default of 1280, about 1,330 visual tokens at 1280 by 800). It keeps the aspect ratio and records the scale `s` (model pixels per physical pixel) and the display's origin on the virtual desktop. A model coordinate `(x, y)` maps as follows:

1. Refuse it, without clamping, when it falls outside the last screenshot's width and height.
2. Convert to physical pixels: `(origin.x + x / s, origin.y + y / s)`, rounded.
3. Convert to the platform's input space:
   - Windows: `SendInput`'s absolute coordinates normalised to 0 to 65535 over the virtual desktop (`MOUSEEVENTF_VIRTUALDESK`).
   - macOS: points, dividing by the display's backing scale.
   - X11: pixels as they are.

`zoom(region)` crops at physical resolution and scales the crop up to the model's long edge, so small text is readable without raising the whole screenshot's cost. A session drives one display, the main one unless the person picks another. A display change between screenshots, such as a resolution change, a monitor unplugged or a scale change, is reported, and the next coordinate is refused until a new screenshot is taken.

### How it meets ADR 0006

**What the session can choose.** A session gains a `desktop` field beside `browser`, with the values none, contained (an endpoint) and local (this machine's live desktop). It is set by a command, recorded as an event, and resolved at run start with a recorded reason, as `run.browser.resolved` is. In more detail:

- **Unattended runs** (routines, bots, parked prompts past their TTL) never get the live desktop. They may get a contained desktop when the operator setting `desktop.contained.allowRuns` is on. This is the headless browser's rule, carried over.
- **The live desktop needs the person's grant for the session.** The first computer call on a session with the live desktop opens a `desktop` prompt: "Let the agent use this computer's screen, mouse and keyboard in this session". It parks like any prompt and is recorded. It is **never automatically approved in any mode, bypass included**: the denylist's rule from ADR 0006 ("never auto-approved in any mode … never blocks a user's own explicit choice"), applied to the whole desktop. Unanswered, it is denied at its TTL.
- **Consequential members, by mode**, on the live desktop after the grant:
  - `plan`: only `screenshot`, `zoom`, `cursor_position` and `wait`.
  - `acceptEdits`: those four freely, pointer actions freely within the granted session, and the toolset's own confirm set (`type`, `key`, `hold_key`) asking each time, with an "allow typing for this session" answer.
  - `auto`: the reviewer rules where the account has it.
  - `bypassPermissions`: no per-action prompt.

  On a contained desktop, every member is an ordinary tool call under the mode, as a headless-browser verb is.
- **The denylist gains a fifth section, `desktopApps`.** It holds app identifiers (bundle ids on macOS, image names on Windows, `WM_CLASS` on X11). Before each click, drag, type or key, the driver judges the app under the pointer, or the frontmost app for keys and typing. A match is put to the person as a `denylist` prompt with a one-time allowance for that call, and denied unattended, as a top-level browser navigation into a listed domain is.

  The presets mirror the browser section's and Claude Code's sentinel warnings:
  - password managers;
  - terminals and shells ("equivalent to shell access", since typing there runs commands outside every gate);
  - System Settings, Control Panel and the registry editor;
  - keychain and credential managers;
  - the person's banking apps.

  The browser section applies too: when a known browser is under the pointer, its window title's host is matched where the platform exposes it. This is best effort, and stated as such.
- **Containment.** bubblewrap and Seatbelt confine the agent's shell, not the apps a click starts, so the live desktop escapes containment entirely. A run whose containment is not off is refused the live desktop, with that reason. A contained desktop is itself the containment.
- **Stop and lock.**
  - A notification, "agent-harness is using your computer", appears at each turn's first action.
  - A stop chord the helper registers interrupts the run, and the helper consumes the key so a page cannot use it.
  - The GUI's Stop button works the same way.
  - Only one session holds a desktop at a time. A second is refused, naming the holder.
- **Untrusted screens.** Every screenshot result opens with a text line saying the image is untrusted screen content and not instructions from the user, the way page text is framed. Through MCP the model does not get the API's server-side screenshot classifiers (Not verified), which is one more reason the live desktop stays attended.

### What the transcript shows

Every screenshot and zoom shows in the transcript under its call, as tool images should already.

Today `withoutFileBytes` in `adapters/claude/mapper.ts` records an MCP image as `{type: "image", mediaType, size}`. The log never holds the bytes, so `picturesIn` in the GUI finds no data and draws nothing for `browser_screenshot`. The model's copy lives only in the Claude CLI's own `tool-results` folder under the account directory (#622).

The proposal is a **retained-image store** in the environment's data directory:

- Content-addressed files, referenced from `tool.ended` by hash, size and media type.
- Read by clients through a `transcript.image` query under `read`, and fetched lazily, so a phone on a slow link pays only for what it scrolls to.
- Removed with the session's purge, following #622's rules.
- Capped per session (`transcript.images.maxMb`, a chosen default of 200, oldest dropped first, with the gap stated).

The browser's screenshots use the same store. Live-desktop screenshots can show anything on the person's screen, and pixels cannot be redacted the way page text is. The proposed defaults:

- They are kept by default, like the rest of the transcript.
- They are marked sensitive, so the GUI blurs them on a phone until tapped.
- A per-session "forget screenshots" action is available.

### Risks and isolation

1. **An agent acting on the person's live desktop.** One wrong click can send an email, approve a payment, or type into a terminal. Prompt injection from the screen is unsolved. The provider's best published figure is about 1% attack success against an adaptive attacker (#292).

   The isolation options, from strongest to weakest:
   - a VM, a contained desktop driven over VNC;
   - a sandboxed virtual display as the person (Xvfb, or Xephyr in a window the person can watch);
   - a separate OS user's session (heavy on Windows and macOS);
   - the live desktop, attended, granted per session, typing confirmed and the app denylist on.

   This is why the contained desktop comes first.
2. **Windows integrity levels.** An elevated window ignores input silently. The helper must detect it and say so.
3. **Wayland.** There is no consent-free input path, and the portal's consent cannot run unattended. Refused in the first phases.
4. **macOS identity.** Grants attach to the bundled Node's identity. Any script that Node runs inherits them, and an environment update that moves the binary's path may lose them (Not verified). A signed helper with its own bundle id is the lasting answer, once the project has a Developer ID.
5. **Cost.** A screenshot is 1,000 to 1,800 tokens. A long desktop session fills context quickly, so the 1280 long edge and `zoom` matter.
6. **Native dependencies.** `robotjs`'s revival is recent, and `node-screenshots` is a single-maintainer Rust binding. Both are wrapped behind the helper, so either can be swapped for a small per-platform binary later.

## 4. Phased plan

Each step is one pull request unless stated. Proof means the tests the step adds plus the checklist items it owes.

### Browser track

1. **New driver verbs.**
   - Adds: `key`, `hold_key`, hover, drag and the low-level pointer verbs, the other clicks with modifiers, `zoom`, `scroll` at a coordinate, `scroll_to`, back, forward and reload, and `form_input` for selects, checkboxes and radios.
   - Files: `packages/contracts/src/browser-driver.ts` (verbs, schemas, deadlines), `packages/browser/src/driver/{driver,page,in-page}.ts`, the extension's page host if any verb needs it, and `packages/contracts/schema/` (export).
   - Proof: scripted-CDP-peer tests for each verb's commands. The fixture-page suite gains a key page, a hover menu, a drag target and a select. New browser-checklist items: "Enter submits the fixture form" and "drag moves the slider".
2. **The tool surface takes the member names.**
   - Changes: the rename and reshape in section 2, `selector` dropped from the model's surface, `toolAliases` in `buildRunOptions`, the descriptions rewritten around the new names, and the `mcp__browser__` prefix check in `permissions/tool-decisions.ts`.
   - Files: `packages/environment/src/browser/{page-tools,tool-server}.ts`, `adapters/claude/options.ts`, `permissions/tool-decisions.ts`, `docs/specs/browser.md` ("The tools"), `docs/agents/browser-checklist.md`.
   - Proof: the tool-server tests rewritten against the new names and schemas. An options test showing the aliases and that none shadows a built-in. A fake-provider test showing a bare `navigate` call reaching the tool.
3. **The tab book and the state footer.**
   - Files: the page key and tab id in contracts, popups adopted in `page.ts`, `packages/extension/src/pages.ts` (several tabs per group), `browser/headless.ts` (targets per context and the tab cap), and `page-tools.ts` (the footer on every successful result, the tab tools).
   - Proof: extension tests on the fake `chrome`, headless tests on the manual clock (the cap, idle close per context), footer golden tests, and a checklist item on a real Chrome opening a popup.
4. **`find` and the `batch` tool.**
   - Files: `packages/browser/src/snapshot/` (a lexical search over the serialised tree) and `page-tools.ts` (`find`, `batch` with the halt text).
   - Proof: unit tests on fixture snapshots, and a batch test whose second call fails and whose third answers "Not executed".
5. **Downloads and uploads.**
   - Headless: `Browser.setDownloadBehavior` into a per-session folder (mode 0700) in the data directory, reported in the footer.
   - Chrome: reported only, since the files land in the person's own downloads.
   - `file_upload` off by default. When it is on, the path is gated as a `read` access, so the denylist's paths section applies, and refused through the relay unless the file is carried.
   - Files: the browser driver, `headless.ts`, `page-tools.ts`, and settings in `browser-settings.ts`.
   - Proof: scripted-peer tests, and a checklist item downloading a fixture file.

### Shared

6. **The retained-image store.**
   - Files: `packages/environment/src/event-log/` or a new `transcript-images/`, `adapters/claude/mapper.ts` (store, then reference), the `transcript.image` method in contracts, `packages/gui/src/transcript/images.ts` and `calls.tsx` (lazy fetch, phone blur), and purge in the session service.
   - Proof: an in-process environment test where a fake provider's image result can be fetched by a client and is gone after purge, and GUI harness tests drawing it.

### Computer track

7. **ADR and spec.** The decisions in section 3, once David answers section 5: the session field, the grant, the desktop denylist section, containment, the stores and the plan. Files: `docs/adr/00NN-…`, `docs/specs/computer.md`.
8. **The contract, the tool server and a fake driver.**
   - Files: `packages/contracts/src/desktop-driver.ts`, the session field and settings, `run.desktop.resolved`, `packages/environment/src/desktop/{tool-server,run-desktop}.ts`, and the `computer` server wired in `serve/start.ts`.
   - Proof: tool-server tests over a scripted desktop that answers screenshots and records input, resolution tests (attended, unattended, completions), and schema export.
9. **The VNC driver and the `desktop` compose profile.**
   - Adds: a pure-TypeScript RFB 3.8 client (raw and CopyRect encodings, VNC authentication), PNG encoding and downsampling without native code, and an opt-in `desktop` profile in `scripts/compose.yaml` with a digest-pinned image.
   - Files: `packages/environment/src/desktop/vnc/`, `scripts/compose.yaml`, and `test/container.test.ts`.
   - Proof: a scripted RFB peer on loopback (handshake, framebuffer, pointer and key events, coordinate scaling, refusal outside the frame), and the compose file read as text. A new service-install checklist item brings the profile up on LAB and runs a session, never on the shared agent box.
10. **Policy for the live desktop.**
    - Adds: the `desktop` prompt kind and the session grant, the `desktopApps` denylist section and presets with the matcher, refusal under containment, the lock, and the mode table.
    - Files: `packages/contracts/src/denylist.ts`, `permissions/`, and `desktop/`.
    - Proof: gate and broker tests per mode, an unattended denial, and a match under the pointer from the scripted driver parking a prompt.
11. **The live helper, Windows first.**
    - Adds: a helper process with `node-screenshots` and `robotjs` as optional dependencies (allowed their install scripts like `node-pty`), DPI awareness, integrity-level checks, the stop chord, and the notification.
    - Files: `packages/environment/src/desktop/helper/`, `pnpm-workspace.yaml`, and the release build's per-platform prebuilds.
    - Proof: unit tests over a fake native module. A new "Computer use" section in `docs/agents/desktop-checklist.md` with Windows items: click Notepad and type; a refusal into an elevated window; DPI at 150%; the stop chord.
12. **macOS, then Linux X11.** Screen Recording and Accessibility detection with a clear "grant it in System Settings" sentence, Retina scaling, the X11 display discovery, and the Wayland refusal. Proof: the checklist's macOS and Linux items.
13. **The relay for a remote run.** The `desktop.local` client-call kind in `client-runtime` and the environment. Proof: the relay seam's two in-process environments, as the browser relay's tests do.
14. **Picker and watching.** A composer chip for the desktop. The live view of a contained desktop in the dock (noVNC) stays in ADR 0014's fog for now.

## 5. Questions for David

1. **Should the harness keep its own browser over MCP, or move to the native toolset if it ever becomes reachable?**
   - (a) Keep ours and reshape it to the member names (recommended): the model's prior transfers, and every harness policy stays.
   - (b) Keep ours with today's names: no churn, but the model keeps working from descriptions instead of training.
   - (c) Use Claude in Chrome through `--chrome`: Anthropic's extension and a claude.ai login, with no per-frame denylist, relay, headless browser or reader.
2. **When, if ever, should there be a Messages API adapter for the native toolsets?**
   - (a) Not now. Record it as an option beside ADR 0015's local loop, tied to API keys in milestone 4 or 5 (recommended): no extra adapter to keep, and the drivers stay toolset-shaped.
   - (b) Build it in milestone 2: native members and classifiers, but it needs a pasted key and a second agent loop to maintain.
3. **Which desktop comes first for computer use?**
   - (a) The contained desktop over VNC first, then the live desktop (recommended): safe first, unattended-capable, and works from the container.
   - (b) The live desktop first: the most useful soonest, and the most risk on day one.
   - (c) Contained only: no risk to the person's machine, and no native apps on their desktop.
4. **Which machines first for the live desktop?**
   - (a) Windows, then macOS, then Linux on X11, with Wayland refused (recommended): Windows has no consent prompt in the way, and macOS's grants and identity need a spike.
   - (b) macOS first: the laptop, at the cost of TCC friction and the Node identity on day one.
   - (c) All three together: one larger pull request per layer, and a slower first proof.
5. **What should the modes allow on the live desktop?**
   - (a) A per-session grant that is never automatically approved, even in bypass, then the toolset's typing members asking below bypass (recommended): one deliberate yes per session, and typing never silent unless in bypass.
   - (b) Only in bypass: simple, but bypass becomes the price of computer use.
   - (c) Confirm every action: safest, and unusable past a few clicks.
6. **Should a run with containment on be refused the live desktop?**
   - (a) Yes, with the reason (recommended): containment never silently stops meaning what it says.
   - (b) Allow it with a warning: flexible, but a contained run can then reach everything a click can.
7. **Should screenshots be kept and drawn in the transcript, the browser's included?**
   - (a) Yes, in an environment store, fetched lazily, capped at 200 MB per session, purged with the session, and blurred on phones (recommended): the person can see what the agent saw, at a disk cost.
   - (b) No, as today: no storage, but computer use cannot be watched or reviewed.
   - (c) Browser screenshots only: no desktop pixels at rest, and no review of desktop runs.
8. **What should file handling do in the browser?**
   - (a) Downloads into a per-session folder in the headless browser only, reported in the footer; `file_upload` off by default and gated as a read when on (recommended): no surprise files, and uploads only when asked for.
   - (b) Both on: closer to the toolset, but uploads can carry workspace files out.
   - (c) Neither: no change, and download flows fail silently.
9. **Should `selector` be dropped from the click and type tools?**
   - (a) Drop it, so refs and coordinates are the only targets, as in the toolset (recommended): the surface matches the prior.
   - (b) Keep it as a third target type: useful on the person's own dev pages, at the cost of one more way to be wrong.
10. **How many tabs should a headless session hold?**
    - (a) 5 (recommended): popups and side-by-side reading work within the memory rules.
    - (b) 1, as now: the simplest, but popups and multi-tab flows break.
    - (c) No cap beyond the context limit: flexible, and the heap watchdog does more work.
11. **What should the desktop app denylist preset hold?**
    - (a) Password managers, terminals and shells, system settings, credential managers and banking apps (recommended): mirrors the browser section, and typing into a terminal always asks.
    - (b) Empty, the person adds entries: no friction, and no floor.

## Not verified

- That `extraArgs: { chrome: null }` turns on Claude in Chrome in an SDK-driven run under the harness's account directories. The Agent SDK 0.3.290 changelog implies SDK sessions can run it. Nothing was run here.
- Whether the Agent SDK will ever accept a client toolset. Nothing published says so.
- Whether the API's screenshot and page-injection classifiers apply to MCP tool results.
- How well the model does with `mcp__browser__<member>` compared with native members. It needs a measured comparison on #292's page set once step 2 lands.
- How macOS behaves with the bundled Node as the Screen Recording and Accessibility client under a LaunchAgent, including across updates.
- The quality of `robotjs`'s 2026 prebuilds and of `node-screenshots` on each platform.
- The action lists of the older `computer_20251124` and `computer_20250124` versions. They are not needed: Claude 5.5 models refuse them on the Claude API.
- No browser, Electron or desktop automation was run on the shared agent box.

## Sources

- Anthropic platform docs, read 2026-10-13: [browser use SDK](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk), [browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), [computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), [tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference), [tool runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner).
- `anthropic-sdk-typescript`: `browser-toolset.md`, `computer-toolset.md`, `helpers.md`, `src/helpers/beta/toolsets/`. The npm registry shows `helpers/beta/toolsets/` first shipping in 0.132.0.
- [claude-quickstarts](https://github.com/anthropics/claude-quickstarts): `browser-toolset/` (CDP driver, five members) and `computer-toolset/` (VNC driver).
- [browserbase/claude-cua-toolset](https://github.com/browserbase/claude-cua-toolset) and its `stagehand-claude-sdk` 0.1.0 types (all 31 members).
- Claude Code docs: [computer use](https://code.claude.com/docs/en/computer-use), [Chrome](https://code.claude.com/docs/en/chrome). The [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (2.0.72 to 2.1.296) and the [Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).
- Installed packages: `@anthropic-ai/claude-agent-sdk` 0.3.289 (`sdk.d.ts` `Options`, `SdkBeta`, `toolAliases`, `tools`), its bundled Claude Code 2.1.289 binary (the `claude-in-chrome` tool names, `--chrome`, `@ant/computer-use-swift is only available on macOS`), and `@anthropic-ai/sdk` 0.128.0.
- Microsoft, [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput). [nut.js README](https://github.com/nut-tree/nut.js). The npm registry for `robotjs`, `@jitsi/robotjs`, `node-screenshots` and the `@nut-tree-fork` packages. Reports on macOS 15's monthly screen-recording prompt (9to5Mac, 2024-08-14), and xdg-desktop-portal's restore tokens.
- The harness: ADR 0006, 0014, 0015, 0018 and 0024, `docs/specs/browser.md`, `docs/specs/permissions.md`, `docs/agents/browser-checklist.md`, `packages/browser/src`, `packages/extension/src`, `packages/environment/src/browser/`, `adapters/claude/{options,mapper,host-tools}.ts`, `permissions/tool-decisions.ts`, `packages/gui/src/transcript/{images.ts,calls.tsx}`, `packages/cli/src/service/{task-scheduler,launchd,systemd}.ts` and `packages/desktop/scripts/desktop-build/config.ts`.
