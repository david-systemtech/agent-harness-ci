# Browser: manual checklist

The half of the CDP page driver (`packages/browser`, ticket #543) and its
snapshot (#544: the vendored aria snapshot and acting by ref) that only a real
Chromium can prove. The automated tests drive the driver over the
scripted CDP peer (`@agent-harness/browser/testing`) on a loopback WebSocket
and a pipe, and run the in-page functions in jsdom; the fixture-page suite
(`packages/browser/src/driver/chromium.test.ts`) proves the same against a
real browser, and skips, saying why, wherever none may run. Run it on a
machine that allows browsers, as an ordinary user, and record the result in
the pull request that changes the driver or its in-page functions. When no
such machine is at hand, the pull request says so and lists the suite as not
run; it stays owed until someone runs it. Never launch a browser on the
shared agent box (SAMPLE-SERVER's container): it has taken out-of-memory
kills from browsers before.

## Where

A machine with Chromium or Google Chrome installed and memory to spare: a
browser container with the headless browser's limits, or a local machine. Not as root: Chromium refuses to start its sandbox as root, and the
suite never turns the sandbox off.

## Run

From a checkout, after `pnpm install`:

```bash
AGENT_HARNESS_CHROMIUM=/usr/bin/chromium \
  pnpm --filter @agent-harness/browser exec vitest run src/driver/chromium.test.ts
```

`AGENT_HARNESS_CHROMIUM` names the executable: `/usr/bin/chromium` on
Debian and Ubuntu, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
on macOS, `C:\Program Files\Google\Chrome\Application\chrome.exe` on Windows.
The suite launches it headless over a pipe with a throwaway profile, serves
its fixture pages (`packages/browser/test/fixtures/chromium/`) from loopback
under `.test` names that `--host-resolver-rules` maps to 127.0.0.1, and
closes it at the end.

## Pass lines

Every case passes:

1. Text a same-site frame shows, and text a cross-site frame shows, is found,
   and the cross-site frame is an `iframe` target: the driver reads every
   frame through child targets.
2. Text inside an open shadow root, and a node slotted into it, is found.
3. A click by selector lands (the page counts one click), the page's own
   `querySelector` is never called (the driver's functions run in an isolated
   world), and no `Runtime.enable`, `Log.enable` or `Network.enable` is sent
   until the first `evaluate`.
4. Typing replaces what a password field and a card field held.
5. Scrolling down two viewports leaves the page 1,600 pixels down, and the
   article's last sentence is waited for.
6. A click at (300, 200) reaches a canvas at that point, and a screenshot is
   a JPEG 1,280 pixels wide and 800 high.
7. A second Chromium, listening on a DevTools port, is driven over a
   WebSocket to its address.
8. A page whose cross-site frame the denylist lists is refused whole, naming
   the sub-frame, and left at about:blank.
9. A snapshot of the frames page reads as one tree: the heading, then the
   same-site frame's text under its iframe with `f1` refs, then the cross-site
   frame's under its own with the next prefix.
10. A click by the cross-site frame's Pay button's ref lands in that frame (its
    text turns to "Paid in full"), and once the page has navigated the same
    ref is refused with "Take a new snapshot".
11. A snapshot of the Lit-style card shows its slotted title as a heading and
    its temperature from inside its shadow root.
12. A snapshot of the fields page shows the password's and the card number's
    markers and neither value, and a click and a typing by ref land on the
    Buy button and the password field.

Record the date, the machine and its platform, the browser and its version
(`chromium --version`), and each case's result in the pull request.

## The relay (#554)

What the browser relay adds per verb (the browser spec's "Verify first", item
5): a run on SAMPLE-SERVER started from the desktop window drives David's
Chrome, paired with his desktop's environment, through the window's runtime.
The relay's tests run two in-process environments and the fake extension; only
David's machines time it.

With the Chrome paired with the desktop's environment and connected, and one
fixed page open in it:

1. **Direct**: a session on the desktop's environment whose browser is that
   Chrome. In one run, ten of each of `browser_open`, `browser_snapshot`,
   `browser_click`, `browser_read` and `browser_screenshot` on the page.
2. **Relayed**: the same from a session on SAMPLE-SERVER started from the same
   desktop window, its browser that Chrome.
3. For each verb on each path, read each call's time from its `tool.started`
   to its `tool.ended` in the session's transcript, and note the median and
   the slowest; what the relay adds is the relayed median less the direct one.

Record the date, both machines, Chrome's version and the table in the pull
request or issue that asked for it (#922).

## The extension (#549)

The extension package's tests run its worker and options page against a fake
`chrome` API and a scripted environment, and its build's test runs the built
worker on a Node thread; none of them loads it in Chrome. Three things only a
real Chrome answers (the browser spec's "Verify first", items 3 and 8). Run
them in Google Chrome on a machine that allows browsers, with a profile you
can throw away, and record the date, the platform, Chrome's version
(`chrome://version`) and each answer in the pull request that changes the
extension's worker, its manifest or its build.

From a checkout, after `pnpm install` and `pnpm build`, start an environment
from the checkout (`node packages/cli/dist/main.js serve --data-dir <a new
folder>`), and in Chrome open `chrome://extensions`, turn on Developer mode,
click Load unpacked and choose the folder the environment made,
(`<data directory>/extension/current`).

1. **The version.** The card shows the version name `0.0.0` and no error.
   Then build it with a prerelease (from `packages/extension`, `node
   --conditions=@agent-harness/source --import tsx scripts/build-extension.ts
   --version 1.2.3-rc.1`), restart the environment, which replaces the folder,
   and click Reload: the card shows `1.2.3-rc.1`, and `chrome://extensions`
   raises no manifest error for `version` (`1.2.3`).
2. **The port file without Reload.** Open the extension's options page: it
   names the port the port file names and says it is connected and not paired.
   Stop the environment, hold its port with another program
   (`python3 -m http.server <port> --bind 127.0.0.1`), and start the environment
   again, which takes the next free port and rewrites the port file. Without
   clicking Reload, within a minute the options page names the new port and
   says it is connected again.
3. **The unpaired socket across Chrome's idle shutdown.** With the extension
   unpaired and connected, close its options page and leave Chrome alone for
   ten minutes. In `chrome://serviceworker-internals`, the extension's worker
   (`chrome-extension://fnmgmfbcdmlefliicojlcpehmcieoajl/`) stays RUNNING
   throughout, its socket's pings keeping it; if it ever shows STOPPED, it is
   RUNNING again within the 30 seconds its alarm takes. Do not open the
   worker's DevTools for this: an open inspector keeps any worker alive.

## The extension driving pages (#553)

The extension's tests run its worker against the fake `chrome` API, whose
tabs and debugger are the scripted CDP peer's, and the environment's end to
end runs the built worker from the folder on a Node thread; none of them
loads it in Chrome. What only a real Chrome answers is the browser spec's
"Verify first", items 2 and 4, and the managed profile's sentence. Set up as
for the extension's section above, pair the Chrome from its options page with
a code from the Browser card (or `agent-harness browser pair`), and make a
session whose browser is that Chrome.

1. **The tab group and the banner.** `browser_open` on `https://example.com/`
   opens a tab in the background, in a tab group titled `agent-harness`, with
   Chrome's debugging banner on it, and the answer names the page. A second
   session's `browser_open` puts its tab in the same group. `browser_close`
   takes the banner away and leaves the tab open. Drag a session's tab out of
   the group: its next verb answers that its page is gone, and `browser_open`
   makes a new tab in the group.
2. **Frames and isolated worlds** (item 2). Open a page with a cross-site
   frame (a page embedding a video from another site) and `browser_wait_for`
   text only the frame shows: it is found, which needs `chrome.debugger` to
   attach to the out-of-process frame as a child target and to allow
   `Page.createIsolatedWorld` there. A refusal naming either is the answer.
3. **Runtime enabled lazily** (item 4; #292, section 5.3, step 5), with David
   in his own Chrome: open a Cloudflare-fronted, a DataDome-fronted and a
   Reddit page twice each, once before any deep verb (Page alone enabled) and
   once after `browser_console` turned `Runtime`, `Log` and `Network` on.
   Note what each served each time (the page, or a challenge), and check
   History afterwards for reCAPTCHA entries.
4. **A managed profile.** In a throwaway profile whose policy turns the
   developer tools off (on Linux, `{"DeveloperToolsAvailability": 2}` in a file
   under `/etc/opt/chrome/policies/managed/`; `chrome://policy` shows it),
   `browser_open` answers that this Chrome does not let extensions use its
   debugger, and so does every verb after. If it answers anything else, read
   the error Chrome itself gives: in the worker's DevTools (from
   `chrome://extensions`), run `const { id } = await chrome.tabs.create({});
   await chrome.debugger.attach({ tabId: id }, "1.3")`. The extension reads
   `Cannot attach to this target.` as the block.

Record the date, the platform, Chrome's version and each answer in the pull
request that changes the extension's pages, or in the issue that asked for it.

## The headless browser's launch (#555)

The environment's headless browser tests (`packages/environment/src/browser/headless.test.ts`)
launch the scripted CDP peer through the launch seam and record the arguments; the
preset launcher's own test runs a few lines of Node in a browser's place. Whether a real
Chromium or Chrome starts the way the environment launches it (new headless, a pipe rather
than a port, a throwaway profile under the data directory, Chromium's own sandbox on, no
`--no-sandbox`) only a real one answers (the browser spec's "Verify first", item 6). Run the
suite's real-Chromium case, which skips unless `AGENT_HARNESS_CHROMIUM` names one, on each
platform, as an ordinary user:

```bash
AGENT_HARNESS_CHROMIUM=/usr/bin/chromium \
  pnpm --filter @agent-harness/environment exec vitest run src/browser/headless.test.ts -t "a real Chromium"
```

1. **macOS**, with Google Chrome
   (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
2. **Windows**, with Google Chrome
   (`C:\Program Files\Google\Chrome\Application\chrome.exe`).
3. **Ubuntu 24.04**, whose AppArmor profile limits unprivileged user namespaces
   (`kernel.apparmor_restrict_unprivileged_userns=1`), with a Chromium or Chrome
   from a `.deb` and, if one is at hand, the snap's `/snap/bin/chromium`, whose
   confinement may not let it write a profile under a hidden folder of the home
   directory (`~/.local/state`).

The case passes where the browser starts, opens a page served from loopback and
takes a screenshot. Where it fails, the model's sentence names how the browser
ended and the last line it wrote (`No usable sandbox!` is the sandbox refused).
Record the date, the platform, the browser and its version, and each result in
the pull request that changes the launch; a platform where the sandbox is
refused is a finding for David, never a reason to turn the sandbox off.
