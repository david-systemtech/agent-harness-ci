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

First launch installing the service and the keychain (#395) have their
section below, which needs a packaged desktop carrying the server artefact:
a run from a checkout carries none, and so does restart to update (#355).
The packaged desktop (#423) has its own section, per platform, as do
notifications and their activation (#405) and the browser dock (#411), which
need their members built. The preview scheme has its section below (#410).

## Before the first run

From a checkout, after `pnpm install`:

1. `pnpm --filter @agent-harness/desktop build` builds the `gui` bundle, the
   main process (`packages/desktop/dist/main.js`) and the preload bundle
   (`packages/desktop/dist/preload.cjs`).
2. `pnpm --filter @agent-harness/desktop start` runs `electron .` in the
   package. The first run downloads Electron's binary: no install does. If it
   cannot, `pnpm --filter @agent-harness/desktop exec install-electron`
   fetches it.
3. On Linux, if Electron stops with "The SUID sandbox helper binary was found,
   but is not configured correctly", give
   `packages/desktop/node_modules/electron/dist/chrome-sandbox` to root with
   mode 4755. Never pass `--no-sandbox`: it turns off the renderer's sandbox,
   which step 3 below proves.

The steps below run in the window's DevTools console (View, Toggle Developer
Tools) unless they say otherwise. `desktopShell` there is the shell the
preload exposes, and a member named bare is on it: `setBadge(3)` is
`desktopShell.window.setBadge(3)`.

## Building a desktop

The sections that need a packaged desktop take the build of their platform
(#423): `build-desktop` builds one platform's desktop on that platform (the
Windows setup on an x86_64 Linux with Wine too, #359), for a release's version,
from that platform's server artefact of the same version. The `desktop`
workflow builds all three, run by hand (Actions, desktop, Run workflow; the
`macos` job waits while the Mac sleeps, the `arch` and `windows` jobs for a
`ci-x64` runner), and keeps no file; a release publishes all three. To keep a
build of no release, run the same commands on a machine that builds it, from a
checkout, after `pnpm install`:

1. **The server artefact.** On macOS or an x86_64 Linux, the release build
   makes the machine's own: `pnpm --filter agent-harness build-artefacts
   --tag v0.0.0-check.1 --out server --platform <darwin-arm64 or linux-x64>
   --image-reference ci.invalid/agent-harness:0.0.0-check.1 --image-digest
   sha256:<64 zeros>`. The Windows artefact is built on the x86_64 Linux
   machine beside its own (`--platform linux-x64 --platform win32-x64`); the
   setup is built from it there, with Wine, or on a Windows machine it is
   copied to.
2. **The desktop.** `pnpm --filter @agent-harness/desktop build-desktop
   --platform <platform> --tag v0.0.0-check.1 --server
   server/agent-harness-<platform>.<tar.gz, or zip for win32-x64> --out desktop`
   writes `desktop/agent-harness-desktop-darwin-arm64.zip`,
   `agent-harness-desktop-win32-x64-setup.exe` or
   `agent-harness-desktop-linux-x64.pacman`. On Linux, electron-builder's
   fpm needs `bsdtar` (Debian's `libarchive-tools`, Arch's `libarchive`), and
   the Windows setup needs Wine, which runs the setup to write its
   uninstaller, and `python3`, which unpacks the Windows zip. A
   server artefact of another version or platform is refused before anything
   is packed. Use a later tag (`v0.0.0-check.2`) for the build that a
   restart-to-update section applies.

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
   `"undefined"`. `Object.keys(await desktopShell.ready())` lists `window`,
   `dialogs`, `clipboard`, `openExternal`, `system`, `http`, `network`,
   `deepLinks`, `secrets`, `localGrant`, `service`, `preview`, `update`,
   `installer`, `gh`, `notifications` and `webView`, plus `camera` when a video input is present; nothing
   named `ipcRenderer` is reachable.
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
   machine's environment opens without a declaration. DevTools itself works
   under the lockdown, its own `devtools:` frontend let through.
7. **http.** With an environment listening,
   `await (await desktopShell.http("http://127.0.0.1:<port>/.well-known/agent-harness/environment")).json()`
   answers its discovery document; `desktopShell.http("https://example.org/")`
   is refused.
8. **The Canvas kept.** `desktopShell.window.setBackgroundColour("#203040")`,
   then shrink and grow the window quickly: that colour shows at its edges.
   Quit and start: the window opens on it before the page paints.
9. **window.** `setTitle("checklist")` retitles the window. Minimise it,
   `setTimeout(() => desktopShell.window.focus(), 2000)`: it comes back to the
   front. Check the frame on each platform (record macOS, Windows and Linux
   separately): there is no OS title bar above the 44px header. Drag its blank
   space to move the window; Settings, search, More and theme controls remain
   clickable and never start a drag. On macOS, native traffic lights occupy
   the reserved 76px left inset; entering full screen removes the inset and
   leaving restores it. On Windows and Linux, the three 28px buttons minimize,
   maximize/restore and close; close turns signal on hover and all three dim
   when another window has focus. OS maximize/restore actions update the middle
   button too. Tab to the buttons: names and tooltips match their actions.
   `await desktopShell.window.state()` agrees with native focus, maximize and
   full-screen changes. Use `desktopShell.window.onChange(console.log)` and
   its returned unsubscribe to verify events stop after unsubscribing.
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

## Scan a pairing QR (#845)

Run on macOS, Windows and Linux with a camera; also launch once with no video
input. Camera discovery happens before the GUI mounts, so restart after
connecting or removing a camera for this check.

1. On another machine, show a fresh pairing QR on its screen. In Settings,
   Your machines, Add a machine, choose **Scan a QR**. The camera preview
   opens in a modal, with Cancel and instructions. Accept the OS's camera
   prompt if shown (macOS's packaged desktop names why it needs the camera).
2. Point the camera at the other screen. One QR closes the preview and
   exchanges its pairing link; confirm the new machine's card.
   The camera's activity light goes off after reading the QR.
3. Scan again, then Cancel, Escape, and close the desktop during capture.
   Each releases the camera; Cancel and Escape leave the pairing form as it
   was. Cancel while the permission prompt is pending too: accepting it
   later must not reopen the preview or keep the camera on.
4. Deny OS camera access. The form shows the failure and stays usable; after
   granting access in the OS's privacy settings, try scanning again.
5. With no video input at launch, Add a machine gives the shell.camera
   absence line and offers no Scan a QR button. Audio inputs alone do not
   provide the member. A camera on Windows or Linux scans the same QR without
   relying on Chromium's BarcodeDetector.

## The theme picker (#1194)

On every platform, with the window connected to this machine's environment:

1. **A live preview.** In Settings, Theme, choose Ember: the whole window
   repaints in its orange accent at once, with no white frame and no
   content-policy error in the console; Cancel paints the saved theme back.
   Quit while a preview shows and start again: the window opens on the saved
   theme's Canvas, never the preview's.
2. **Export.** Export, then Download `<name>.json`: the OS saves the file
   (asking where, or into its downloads folder), and it holds the theme's
   name and seven seeds and nothing else.
3. **Import.** Import opens the OS's file dialog filtered to JSON; choosing
   the exported file previews it, and a file that is not a theme file is
   refused with its reason, nothing saved.

## The terminal pane under the content policy (#409, #486)

On every platform, with the window connected to an environment (this
machine's, or one paired) and a session open in the pane:

1. **It draws in the theme.** Press Mod+J (⌘J on macOS, Ctrl+J elsewhere):
   the side column shows the Terminal pane with a shell prompt, its ground
   the side column's and its text the theme's ink, each row one cell high in
   the system's monospace font, the cursor drawn. `ls --color=always /` (or
   `ls -G /` on macOS) shows coloured names; typing reaches the shell and
   `exit` says how the terminal ended, with New terminal.
2. **No inline stylesheet.** In the console, `document.querySelectorAll("style").length`
   is `0` and `document.adoptedStyleSheets.length` is at least `3` (xterm.js's
   scroll bar, colours and cell sizes). The console shows no content-policy
   error, before or after the pane opened, nor after the window was resized.
3. **It runs on.** Press Mod+J again: the column hides. Quit and start the
   window, open the same session and press Mod+J: the same shell is drawn
   again from its scrollback. Close the pane with the strip's ×, then press
   Mod+J: a new shell opens, the closed one gone.

## The preview scheme (#410)

On every platform, with the window connected to an environment and a
session open in the pane whose workspace you can write to:

1. **A page, framed.** Ask the session to write `preview-check.html` holding
   `<h1>Checklist</h1><script>document.body.append(" ran")</script>` and
   `<img src="https://example.org/x.png">`. Open Side panes, Documents: the
   page is listed with its size. Press Preview: the Preview pane frames it
   on white, reading "Checklist ran" (its script ran), with no picture. The
   console shows the picture refused by the preview's policy, and no error
   from the app's own policy.
2. **Sandboxed, without same-origin.** Have the page run
   `try { parent.document.title } catch (e) { document.body.append(" " + e.name) }`
   and `document.body.append(" " + origin)`: it reads `SecurityError` and
   `null`, and `typeof desktopShell` inside the frame is `"undefined"`. A
   `fetch("https://example.org")` or a `new WebSocket("ws://127.0.0.1:1")`
   from it fails, and `window.open("https://example.org")` opens nothing,
   in the window or the OS's browser.
3. **A snapshot.** Have the session change the heading. The Preview still
   shows "Checklist" until Preview is pressed again, which reads it again.
   In the console of the window's own page, `await fetch(<the frame's src>)`
   fails (no fetch on the scheme), and a made-up
   `agent-harness-preview://00/` in a new frame answers nothing.
4. **An SVG and markdown.** An SVG the session writes is framed as a
   picture; a markdown file is drawn in the pane in the window's theme, not
   framed.

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

## The packaged desktop (#423)

Run on each platform with the build of "Building a desktop", installed as an
ordinary user. The builds are unsigned (signed ad hoc on macOS) in milestone
1, so each OS warns once when one is first opened from a download.

### Every platform

1. **Its version.** In the console, `await desktopShell.update.current()`
   answers the version it was built as (`0.0.0-check.1`), the platform and
   architecture, and its format; `await desktopShell.installer.bundledServer()`
   answers the same version and the `server` folder in the app's resources.
2. **The scheme from the install.** Before the app's first start (on
   Windows, install with `/S`, which starts nothing), open
   `agent-harness://pair?code=CHECKLIST` from a terminal (`open`, `start` or
   `xdg-open`): the app starts, and a
   `desktopShell.deepLinks.onOpen(console.log)` listener added once its
   window is up is handed the link. So the install registered the scheme,
   not the app as it starts.

### macOS

1. **One bundle.** The zip unpacks to `agent-harness.app` alone. Move it to
   Applications and open it: Gatekeeper refuses an unsigned download once;
   System Settings, Privacy & Security, Open Anyway opens it, and it opens
   without asking after that. `codesign -dv /Applications/agent-harness.app`
   says `Signature=adhoc`, and `codesign --verify --deep --strict` passes.
2. **Its resources.** `Contents/Resources/server/node/bin/node --version`
   runs the artefact's Node, and `Contents/Info.plist` lists `agent-harness`
   under `CFBundleURLTypes`.

### Windows

1. **Silent, per user.** On a machine it was never installed on, as an
   ordinary user, run `<setup> /S` from a command prompt: no window and no
   administrator prompt; it installs into
   `%LOCALAPPDATA%\Programs\agent-harness` with a Start menu shortcut and
   starts nothing. `reg query HKCU\Software\Classes\agent-harness\shell\open\command`
   names `"<the install directory>\agent-harness.exe" "%1"`.
2. **From a download.** Uninstall it, then open the setup from Explorer:
   SmartScreen warns once for the unsigned setup (More info, Run anyway), it
   installs as step 1 did with its progress shown, and starts the app.
3. **The hand-over.** With the app running, run
   `<setup> /S --updated --force-run`: the setup waits for the app to exit
   (quit it), installs over it with no window and starts it again.
4. **Uninstalled (#1478).** First start the installed environment and confirm
   `service status` says running and ready. Quit the desktop, then uninstall
   from Settings, Apps (also repeat with `Uninstall agent-harness.exe /S`).
   `schtasks /Query /TN agent-harness` finds nothing, nothing answers on the
   environment's port, and its launcher and server processes are gone. The
   install directory and scheme registry key are gone; `launcher-entry.cmd`,
   `bin\agent-harness.cmd` and `service.json` are removed from the data directory.
   `%LOCALAPPDATA%\agent-harness` keeps personal data, desktop preferences and
   server versions. Reinstall and start: the retained environment is usable.
   To remove retained data as well, delete that folder after uninstalling.
   If service cleanup fails, uninstall exits nonzero and keeps the app's
   resources. The task is disabled during cleanup to prevent another start;
   `service-stop.json` in the data directory retains verified process identities
   and exit times so retry checks survivors even after the scheduled action
   has stopped. Successful cleanup removes that record. If a recorded identity
   cannot be verified, cleanup keeps the registration instead of guessing which
   process to stop. If a recorded process was ended outside cleanup, including
   by a reboot, confirm the environment port is closed and all recorded processes
   have stopped. Then delete `service-stop.json` from the data directory and
   retry uninstall. A descendant that exits before its handle is captured is
   not recorded and does not require this recovery. Reinstall enables the task
   again but does not clear an unfinished cleanup record.
   The hosted release smoke starts the installed task before uninstall and
   checks launcher/server exit, port closure, task removal, data retention
   and an unrelated Node process staying alive. Its temporary user's batch
   logon uses a Password principal with the installed action and limited
   token; repeat with the normal InteractiveToken logon on a Windows desktop.

### Arch

1. **Installed.** `sudo pacman -U agent-harness-desktop-linux-x64.pacman`
   installs it with its dependencies from Arch's repositories, into
   `/opt/agent-harness`. `pacman -Qqo /opt/agent-harness/agent-harness-desktop`
   names `agent-harness-desktop`; `agent-harness-desktop` starts it from a
   terminal, and `agent-harness` there is still the CLI's command, not the
   desktop's.
2. **The desktop entry.** The launcher lists agent-harness, and
   `xdg-mime query default x-scheme-handler/agent-harness` names
   `agent-harness-desktop.desktop`.
3. **Replaced.** Build the same platform again as `v0.0.0-check.2` and
   `sudo pacman -U` it over the first: pacman upgrades
   `agent-harness-desktop` in place with no file conflict, `pacman -Q
   agent-harness-desktop` names the new version, and the app starts from the
   launcher.

## Notifications and their activation (#405)

On each platform, with a packaged desktop (the notification's sender is the
installed app) connected to an environment:

1. **Only while unfocused.** With the window focused, park a prompt in a
   session: no OS notification. Focus another app and park another: one OS
   notification, naming the session and what waits ("Bash is waiting for
   permission").
2. **Activation.** Click it: the window comes to the front, restored if it
   was minimised, with that session open in the focused pane.
3. **A run ending.** With a session shown in a pane and the window behind
   another app, let its run end: one notification with the reply's first
   line. A run ending in a session no pane shows raises none.
4. **The title and the badge.** While a prompt waits the window's title
   reads "needs you · agent-harness" and the badge counts the sessions
   waiting (the platform's badge step above); once answered, "working" while
   a run goes on, then "ready".
5. **From the console.** `desktopShell.notifications.onActivate(console.log)`,
   then `desktopShell.notifications.show({ title: "Checklist", body: "Click me", tag: "checklist-tag" })`:
   a click logs `checklist-tag`; shown without a tag, a click logs nothing.
6. **macOS.** The first notification asks for permission once; record
   whether it did, and that the Dock badge follows (see macOS step 3 above).
7. **Windows.** The notification names the app, not Electron: the setup's
   Start menu shortcut carries the app's id (`dev.systemtech.agent-harness`),
   which the app sets as its AppUserModelID. Record which. Run from a
   checkout, the app sends as Electron's executable instead; record whether
   Windows showed that one.
8. **Linux.** Under a notification daemon (GNOME, KDE Plasma), the same as
   steps 1 to 3. Record what step 5 does with no daemon running: where
   Electron says the OS offers no notifications, `show` rejects with "This
   desktop cannot show notifications: the OS offers none to it."

## The browser dock (#411)

Needs the shell's `webView`, which #411 builds: until it lands, record this
section as not run. On each platform, with a session open in the pane:

1. **A page per session pane.** Open the browser dock and load
   `https://example.org`: the page draws in the side column. A second
   session pane's dock opens a page of its own.
2. **A partition of its own.** Sign in to a site in the dock: the app's
   own page sees none of its cookies or storage, and the dock keeps them
   when the app is started again.
3. **Hidden, not closed.** Hide the side column and show it again, or
   switch to another pane and back: the dock's page is as it was left, not
   reloaded.
4. **The lockdown stands.** A link in the dock's page opens in the dock;
   the app's own page stays on `agent-harness://app/`, and the console shows
   no content-policy error from it.

5. **Loading and Stop.** Navigate to a slow page: Reload becomes the named
   Stop icon and its tooltip says Stop. Stop cancels the load and restores
   Reload without an error strip. Reload again and let it finish: Reload
   returns. Repeat through an in-page link and history navigation; an iframe
   loading by itself must leave Reload visible. Hide and restore the dock
   during the load: Stop still reflects that page's state.

## First launch and the keychain (#395)

Run on each platform with a packaged desktop (#423's artefact) as an ordinary
user who has no agent-harness service installed (`agent-harness service
status`, from a release's shim, says `Installed: no`, or the user is new).
`<data>` is the environment's data directory, `<desktop>` the desktop's
(`<data>/desktop`).

### Every platform

1. **First launch installs and starts the service.** Start the desktop. The
   window says "Starting the environment on this machine…", then "<name> is
   starting…", and the sidebar then lists this machine's environment by name
   with no session open. `<data>/bin/agent-harness service status` says
   installed, running and ready; `<data>/versions` holds the desktop's
   version, complete; the service's definition runs `<data>`'s launcher
   entry, never a path inside the app.
2. **Opted out.** Turn "Run an environment on this machine" off: the window
   shows pairing. Stop the service (`service` has no stop verb: stop it
   through the OS's service manager), quit and start: the window opens on
   pairing and starts nothing. Turn the switch on: the service starts and the
   window follows it to ready.
3. **A service down is offered, not started.** With the switch on, stop the
   service, quit and start: the heading says "Not running" with Start, and
   nothing starts until Start is pressed.
4. **Pairing.** On another machine's environment, `agent-harness pair` prints
   a link and a code. Paste the link in "Pair with an environment…": the
   environment is listed and connects. Pair again with a code that is wrong,
   then one past its ten minutes: each says one line, "Not paired: …". Open
   `agent-harness://pair?link=<the link, percent-encoded>` from a terminal
   (`open`, `xdg-open` or `start`): the window comes forward and pairs.
5. **The keychain.** After pairing, `<desktop>/secrets/<environment id>.secret`
   exists, readable by its owner alone, its bytes beginning with Chromium's
   encryption prefix (`v10` or `v11`) and nothing in it
   readable as text. Quit and start: the paired environment connects without
   pairing again.
6. **The log.** In the console, `console.error("checklist")`: a line
   `... The window: checklist (...)` is appended to
   `<desktop>/logs/desktop.log`.

### macOS

1. **The Keychain prompt.** The first token kept may ask to let the app use
   "agent-harness Safe Storage" in the login keychain: record whether it
   asked, and that allowing it keeps later launches quiet.
2. **Replace an app with existing credentials (#1480, #1565, #1572).** Keep
   environment data, accounts, paired connections and encrypted files in place.
   Quit, verify the new ZIP's SHA-256 and replace the app in Applications.
   With stable signing or OS approval, verify retained credentials reconnect.
   With an unsigned identity change, refusal or an unanswered prompt settles
   within 30 seconds: the window stays usable, the ciphertext remains, and the
   notice says the previous build's stored credentials could not be read and
   offers Pair again for paired environments. While waiting, the notice says
   macOS is asking for access and answering its prompt keeps the credentials.
   Both notices stay visible in Settings. Verify fresh OS-protected pairing
   and readback, re-pairing the affected environments, and a ready local
   environment through its local grant. Verify the carried upgrade preserves
   environment identity and accounts. Quit during pending access and verify
   the desktop and its credential helper exit.
   The hosted release smoke replaces a differently signed fixture app,
   exercises pending-read shutdown with a locked test Keychain, then unlocks
   before a normal read and accepts retained access or explained bounded
   recovery. Both branches require fresh OS-protected storage/readback and a
   real launcher upgrade from a lower-stamped server to local readiness. It
   never pre-authorises the replacement or clicks an OS approval control.
   It does not prove earlier-release data migrations. Run native checks on
   hosted runners, never a person's Mac. Signing/notarisation is tracked in
   #1571 and must make the hosted retained-read branch pass.
3. **Translocation.** Unzip the download in Downloads and open the app from
   there without moving it (Gatekeeper runs it translocated, from a read-only
   path). Run step 1: the install reads the bundle and copies the version
   out, so it works from there. Then `xattr -l <data>/versions/<v>/node/bin/node`:
   record whether the copy carries `com.apple.quarantine`, and whether
   launchd starts the service with it (if Gatekeeper refuses the copied Node,
   the install must strip the attribute).

### Windows

1. **The install directory.** Install per user with the NSIS setup and run
   step 1 from the Start menu shortcut: the install runs from
   `%LOCALAPPDATA%\Programs\agent-harness\resources\server` (a path with a
   space in the user's name included) with no console window showing, and
   Task Scheduler's task runs `<data>\launcher-entry.cmd`.
2. **DPAPI.** Sign out and in: the paired environment still connects.

### Linux

1. **A secret service.** Under GNOME Keyring or KWallet, step 5's file begins
   `v11`.
2. **No secret service.** Start the desktop with `--password-store=basic`, or
   in a session with no keyring: pairing still works, the file begins `v10`,
   and `desktop.log` says once that tokens are stored unprotected. Settings,
   Your machines: the paired environment's card says tokens are stored
   unprotected, and this machine's card does not (#416); under step 1's
   secret service no card says it.

## Restart to update (#355)

Run on each platform with a packaged desktop (#423's artefact) of a release
installed, and a newer release on its environment's channel that publishes
the desktop's builds. `<data>` is the environment's data directory. The
runtime checks at the local environment's first ready and hourly, stages the
newer build through `updates.desktop.stage` and hands it to the shell for the
next quit on its own; until the window shows "Restart to update", step 3
applies it from the console. The environment stages the build in
`<data>/desktop-builds/`, a folder of its own beside the desktop's
`<data>/desktop` (#788).

### Every platform

1. **What it runs.** `await desktopShell.update.current()` answers the
   version installed, the platform, the architecture and the format: `zip`
   on macOS from Applications, `nsis` on Windows, `pacman` on Arch.
2. **At the quit.** Start the desktop, wait until
   `<data>/desktop-builds/<newer>/` holds the build, then quit. Start it
   again: `current()` answers the newer version, and the paired environments
   connect without pairing again.
3. **Now.** With a newer release again, once it is staged: `await
   desktopShell.update.apply({ path: "<the staged file>", version:
   "<newer>", sha256: "<its SHA-256>" }, "now")`. The window closes and the
   desktop starts again at the newer version. Apply it again with one digit of
   the SHA-256 changed: it answers `failed`, `install`, and nothing quits.
4. **Nothing left behind.** `<data>/desktop/logs/desktop.log` holds no
   cleanup failure after steps 2 and 3.

### macOS

1. **The swap.** After step 3, `/Applications` holds the bundle alone, no
   `.agent-harness.app-update-*` folder; the new bundle opens without a
   Gatekeeper prompt and `codesign --verify --deep --strict` passes on it.
2. **A bundle it cannot replace.** Open the app from the unzipped download
   without moving it (translocated), or from a disk image: `current()`
   answers the format null, and applying answers `failed`, `install`,
   pointing at the release page.

### Windows

1. **Silent.** Step 3 shows no setup window, and the desktop starts again
   from the same Start menu shortcut; step 2 installs as it quits and does
   not start it again.

### Arch

1. **pkexec.** Step 3 asks for a password in the polkit dialog; afterwards
   `pacman -Qo <the desktop's executable>` names the newer version.
2. **Refused.** Cancel the dialog: `apply` answers `failed`, `install`, saying
   the authentication was refused and the installed version stays; `pacman
   -Q` names the old version, and the desktop keeps running.
3. **Not a package.** Run an unpacked copy of the app outside pacman's files:
   `current()` answers the format null.

## This computer's gh (#419)

On every platform, with `gh` 2.40 or later installed through the platform's
usual package manager (Homebrew on macOS, `winget` on Windows, the
distribution's package on Linux), and the window connected to an environment
offering `forge` with `admin`:

1. **Signed in.** Run `gh auth login` for github.com in a terminal, then
   start the desktop from the dock, Start menu or launcher (not from that
   terminal). In Settings, Forges, Add a forge, type `https://github.com` and
   press Use the gh signed in on this computer: the card appears with
   "The gh token <user>@<host> handed over once: it will not follow gh's
   rotations.", and `gh auth token` in the terminal prints the token the
   environment verified with.
2. **Not signed in.** Run `gh auth logout --hostname github.com`, remove the
   forge account, and press it again: the dialog says gh is not signed in to
   github.com, and nothing is added.
3. **Not installed.** Uninstall `gh` (or rename it), and press it again: the
   same line, and the desktop's log shows no error.
4. **The token variables.** Start the desktop from a terminal with `GH_TOKEN`
   set to another token, running its binary so it inherits the terminal's
   variables (on macOS the app bundle's `Contents/MacOS` executable, not
   `open -a`, whose launch does not pass them on): the token handed over is
   the one `gh` stores, not `GH_TOKEN`'s.
