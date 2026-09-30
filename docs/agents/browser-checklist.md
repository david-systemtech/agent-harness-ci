# Browser: manual checklist

The half of the CDP page driver (`packages/browser`, ticket #543) that only a
real Chromium can prove. The automated tests drive the driver over the
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

Record the date, the machine and its platform, the browser and its version
(`chromium --version`), and each case's result in the pull request.
