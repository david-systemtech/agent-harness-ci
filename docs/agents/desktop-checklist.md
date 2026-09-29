# Desktop: manual checklist

The half of the desktop shell (`packages/desktop`, ticket #394) that only a
real window can prove. The automated tests drive the main process with
Electron's modules faked and the platform injected (`packages/desktop/test/`),
and evaluate the preload bundle as the sandbox runs it; these steps prove the
same against Electron and the OS. Run each section on a machine of that
platform, as an ordinary user, and record the result in the pull request that
changes the desktop shell. When no machine of a platform is at hand, the pull
request says so and lists that section as not run; it stays owed until someone
runs it there. Never run Electron on the shared agent box.

The desktop build (#423) adds its own sections here: first launch installing
the service, the keychain, notifications and their activation, the browser
dock, the preview scheme, and restart to update (#355).

## Before the first run

From a checkout, after `pnpm install`:

1. `pnpm --filter @agent-harness/desktop build` builds the `gui` bundle, the
   main process (`packages/desktop/dist/main.js`) and the preload bundle
   (`packages/desktop/dist/preload.cjs`).
2. `pnpm --filter @agent-harness/desktop start` runs `electron .` in the
   package. The first run downloads Electron's binary: no install does.
3. On Linux, if Electron stops with "The SUID sandbox helper binary was found,
   but is not configured correctly", give
   `packages/desktop/node_modules/electron/dist/chrome-sandbox` to root with
   mode 4755. Never pass `--no-sandbox`: it turns off the renderer's sandbox,
   which step 3 below proves.

The steps below run in the window's DevTools console (View, Toggle Developer
Tools) unless they say otherwise. `shell` there is `window.desktopShell`.

## Every platform

1. **Opens on the Canvas.** Delete the desktop's data directory
   (`~/.local/state/agent-harness/desktop` on Linux,
   `~/Library/Application Support/agent-harness/desktop` on macOS,
   `%LOCALAPPDATA%\agent-harness\desktop` on Windows) and start. The window
   opens on the preset's Canvas in the ladder the OS prefers, never a white
   frame, and the console shows no content-policy or loading error.
2. **The app scheme.** `location.href` is `agent-harness://app/`. Change
   something the window keeps (drag the sidebar's divider), quit and start
   again: it is kept, so IndexedDB has a stable origin.
3. **The sandbox.** `typeof require`, `typeof process` and `typeof module` are
   `"undefined"`. `Object.keys(desktopShell)` lists exactly `window`,
   `dialogs`, `clipboard`, `openExternal`, `system`, `http`, `network` and
   `deepLinks`; nothing named `ipcRenderer` is reachable.
4. **The content policy.** `eval("1")` throws a content-policy error;
   `document.head.append(Object.assign(document.createElement("script"), { textContent: "window.ran = 1" }))`
   leaves `window.ran` undefined; `fetch("https://example.org")` fails.
5. **Navigation.** `location.href = "https://example.org"` opens the page in
   the OS's browser and the window stays on the app. `window.open("https://example.org")`
   does the same and opens no second window. `location.href = "file:///"`
   does nothing at all.
6. **The request lockdown.** `new WebSocket("wss://example.org")` fails at once
   (the console names `ERR_BLOCKED_BY_CLIENT`). With an environment on another
   machine, `await desktopShell.network.allow(["http://<its host>:<its port>"])`,
   then a WebSocket to `ws://<its host>:<its port>/ws` opens; allow `[]` again
   and a new one fails. A WebSocket to `ws://127.0.0.1:<port>/ws` of this
   machine's environment opens without a declaration. Record whether DevTools
   itself kept working under the lockdown.
7. **http.** With an environment listening,
   `await (await desktopShell.http("http://127.0.0.1:<port>/.well-known/agent-harness/environment")).json()`
   answers its discovery document; `desktopShell.http("https://example.org/")`
   is refused.
8. **The Canvas kept.** `desktopShell.window.setBackgroundColour("#203040")`,
   then shrink and grow the window quickly: that colour shows at its edges.
   Quit and start: the window opens on it before the page paints.
9. **window.** `setTitle("checklist")` retitles the window. Minimise it,
   `setTimeout(() => desktopShell.window.focus(), 2000)`: it comes back to the
   front.
10. **dialogs.** Each opens modal to the window (a sheet on macOS):
    `openFile({ multiple: true })` answers the paths chosen, `[]` when
    cancelled; `openFileContents({ maxBytes: 1024 })` on a small and a large
    file answers the small one's bytes and the large one's size with
    `bytes: null`; `openDirectory()` and `save({ defaultPath: "notes.md" })`
    answer a path, `undefined` when cancelled.
11. **clipboard.** `writeText("checklist")`, then paste into another app.
    Take a screenshot to the clipboard: `readImage()` answers its bytes as
    `image/png`; copy text only and it answers `undefined`.
12. **openExternal.** `openExternal("https://example.org")` opens the OS's
    browser; `openExternal("file:///")` is refused.
13. **system.** `system()` answers this machine's platform (`darwin`, `linux`
    or `win32`), architecture, hostname and login name.
14. **Closing.** Closing the window quits the app.

## macOS

1. **Deep links.** In the console, `desktopShell.deepLinks.onOpen(console.log)`.
   From Terminal, `open "agent-harness://pair?code=CHECKLIST"`: the window
   comes forward and the console logs the link. An unpackaged app may not be
   the scheme's handler until the build (#423) declares the scheme in its
   bundle; record which.
2. **A cold launch.** Quit, then `open "agent-harness://open/checklist"`: the
   app starts, and a listener added once the window is up is handed that link.
3. **The badge.** `setBadge(3)` shows 3 on the Dock icon, `setBadge("!")`
   shows `!`, `setBadge(undefined)` clears it. The Dock badge needs
   notification permission: record whether macOS asked.

## Windows

1. **One instance.** With the app running, start it again from its shortcut:
   no second window opens, and the first comes to the front, restored if it
   was minimised.
2. **Deep links.** Add the listener as on macOS, then from a command prompt
   `start agent-harness://pair?code=CHECKLIST`: the window comes forward and
   logs the link. Quit, run the same command: the app starts and hands the
   link to a listener added once the window is up.
3. **The badge.** With the window behind another, `setBadge(3)`: the taskbar
   button flashes until the window is focused. `setBadge(undefined)` stops it.

## Linux

1. **One instance and deep links.** As on Windows, with
   `xdg-open "agent-harness://pair?code=CHECKLIST"`. Unpackaged, the scheme
   is claimed through `xdg-settings`; record whether the desktop environment
   honoured it, since the Arch package's desktop entry (#423) claims it
   properly.
2. **The badge.** On a launcher with the LauncherEntry API (KDE Plasma, Ubuntu
   Dock), `setBadge(3)` shows 3 and `setBadge(undefined)` clears it. The
   badge follows the app's `.desktop` file, so an unpackaged run may show
   none; record which.
