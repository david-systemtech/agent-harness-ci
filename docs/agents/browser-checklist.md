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
shared agent box (SYSTEM-SERVER's container): it has taken out-of-memory
kills from browsers before.

## Where

A machine with Chromium or Google Chrome installed and memory to spare: a
browser container on MNL with the headless browser's limits, or David's own
machine. Not as root: Chromium refuses to start its sandbox as root, and the
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
