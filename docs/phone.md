# Use agent-harness from a phone

The packaged environment serves the same client as the desktop at `/`.
Sessions and runs belong to the environment and continue when you close the
phone client. You need a release containing the web client, a configured
HTTPS origin, tailnet access and an environment with a signed-in provider
account. No Node.js, desktop app or separate frontend is installed on the phone.

## Prepare the environment's HTTPS address

These are configuration instructions for the environment operator. Repository
builders do not deploy them, change tailnet configuration or configure live
receivers. The coordinator performs deployment and live QA.

Download the server archive for the environment's platform from the release
linked in the [README](../README.md#install), check its `.sha256` sidecar and
unpack it. It contains its own Node and `bin/agent-harness` (Windows:
`bin\agent-harness.cmd`), plus the version-matched static web assets. Run as
an ordinary OS user, never root. Native service installation is covered in
the [service checklist](agents/service-install-checklist.md).

Choose the device's MagicDNS name and an unused HTTPS port after inspecting
existing Serve configuration. In this example, replace both placeholders
and keep `:8443` everywhere; use the actual chosen port if different:

```sh
# On the environment machine, from the unpacked server directory:
./bin/agent-harness serve --port 7433 --web-origin 'https://<device>.<tailnet>.ts.net:8443'
```

`--web-origin` requires a canonical HTTPS origin: lowercase hostname, no path
or trailing slash, query, fragment or credentials. Omit explicit `:443`;
keep a non-default port. It controls advertised pairing/attention links and
trusted browser Origin, rather than trusting forwarded headers. It does not
make the environment's HTTP listener serve TLS.

In another terminal, an operator with tailnet configuration authority uses:

```sh
tailscale serve status
# Only after confirming this HTTPS port is free:
tailscale serve --bg --https=8443 http://127.0.0.1:7433
tailscale serve status
```

Enable tailnet HTTPS certificates when prompted. Preserve other Serve
services; do not reset their configuration or enable Funnel. Serve is for
private tailnet access, and tailnet policy must allow the phone to reach the
chosen HTTPS port. Verify the reported address matches `--web-origin`, the
certificate is valid and `/ws` is forwarded. See
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and
[its CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

For an installed service, put
`AGENT_HARNESS_WEB_ORIGIN=https://<device>.<tailnet>.ts.net:8443` in the
service manager's environment and restart that environment safely. For a
container, put that line in the `.env` file beside `compose.yaml` and run
`docker compose up -d`; do not edit `compose.yaml`, since an update replaces
it with the next release's file while `.env` stays. Exporting it in an
unrelated terminal does not update an already-running service. `serve` reads
this variable when `--web-origin` is absent; `service install` does not take
`--web-origin`. Keep the same data directory and listener port. The foreground command above
is an alternative to a running service, not a second environment on its port.

Behind Serve every phone reaches the environment from `127.0.0.1`. For a
request from loopback whose Host is the web origin's, the environment takes the
client's address from the `X-Forwarded-For` header Serve sends, and its
Tailscale login from `Tailscale-User-Login`, which Serve drops when a client
sends it: the Access log shows them, and each phone spends its own pairing
rate limit. It never trusts those headers from a tailnet or LAN address. A
proxy that is not Serve is named by the header it writes the address in, with
`--client-address-header` or `AGENT_HARNESS_CLIENT_ADDRESS_HEADER`, even when
that header is `X-Forwarded-For`; behind a named proxy no login is read, since
it passes a client's own `Tailscale-User-Login` on.

Install Tailscale on the phone, join the same tailnet and connect. Open
`https://<device>.<tailnet>.ts.net:8443/`. Tailnet encryption alone does not
make `http://<address>:7433` a browser secure origin. Plain tailnet HTTP lacks
service workers, eligible app installation, Web Push, Async Clipboard and
in-page camera access. Ordinary copy/paste and some browsers' manual
bookmarks/Home Screen shortcuts remain available; shortcuts do not enable
those APIs.

## Choose the grant

Run pairing commands on the environment machine as its OS user, using the
installed shim below or `./bin/agent-harness` from the archive. For a custom
data directory or listener, append `--data-dir <path> --port <port>` to each
command; these identify the local environment, not the HTTPS proxy's port.

| Visible pairing choice | Command | Scopes | Run ceiling |
| --- | --- | --- | --- |
| **A phone with limited access** | `agent-harness pair --preset phone` | `read`, `sessions:write`, `runs:drive` | `acceptEdits` |
| **Me** | `agent-harness pair --preset own-client` | `read`, `sessions:write`, `runs:drive`, `terminal`, `admin` | `bypassPermissions` |
| **Custom** | `agent-harness pair --preset custom` | Defaults to `read`; choose scopes explicitly | Defaults to `plan`; choose a ceiling explicitly |

**A phone with limited access** (`--preset phone`) is the restricted choice
for persistent browser storage. **Me** (`--preset own-client`) remains a
valid, deliberate full-access choice for your own phone. Opening a link in a
phone browser never changes its minted grant: an existing `own-client` link
is not downgraded. The commands print the preset, scopes, ceiling, HTTPS link,
QR and code. Inspect that grant before accepting.

To mint a code in a trusted client, open
**Settings → Settings rows → Your machines**, find the environment's card
and its **Pair another client** section. Under **Who is it for?**, **Me** is first and selected by default
when your current client can grant it. The other visible choices are
**A phone with limited access** and **A program or bot**. Expand
**More options → Custom**
to choose scopes and **How much may its agents do without asking?**, then
choose **Make a pairing code**.

To keep `acceptEdits` while granting Settings/provider sign-in, deliberately
mint an expanded Custom code:

```sh
agent-harness pair --preset custom --scopes read,sessions:write,runs:drive,admin --ceiling acceptEdits
```

If you also want Files, Diff and terminals, add `terminal` explicitly:

```sh
agent-harness pair --preset custom --scopes read,sessions:write,runs:drive,terminal,admin --ceiling acceptEdits
```

A terminal can run commands outside the run-mode ceiling; grant it only when
intended. The same expanded **More options → Custom** form can mint these
codes. A minter cannot grant beyond its own scopes or
ceiling, and the phone cannot raise its own grant. Re-pair and confirm
replacement of the saved connection when you deliberately change authority.

## Change a phone's access

On the restricted phone, choose **Give this phone full access**. On a trusted
client, use the **Pair another client** section above, choose **Me** and
**Make a pairing code** (or run CLI `--preset own-client` on the environment).
Paste the new link or scan its QR in the phone's upgrade form. The successful
pairing replaces this phone's saved connection; it cannot mint its own
higher-access code. For selected extra scopes instead of full access, mint
an expanded **More options → Custom** code with the scopes and ceiling you
intend, then re-pair and confirm replacement of the saved connection.

Alternatively, another admin client can open **Settings → Settings rows →
Access** for this environment, find the phone and choose **Change access**.
The **Access preset** choices there are **Full access** (the `own-client`
grant), **Restricted phone** (the `phone` grant) and **Custom**. Choose the
intended grant and **Save access**. This changes access in place without a
new code: the phone reconnects with its existing token, and running runs
keep their resolved policy. The admin cannot grant beyond its own scopes or
ceiling or change its own client's grant. Choosing **Restricted phone**
later restores the restricted scopes and ceiling.

## Pair and use a session

1. Open the printed HTTPS link or scan the CLI/desktop QR with the phone's OS
   camera. `/pair#<code>` carries a single-use code valid for ten minutes; it
   is removed from the address before the client renders or navigates away.
   Do not share pairing links, QR captures or codes in logs or reports.
2. Alternatively, open `/` and enter the address and code/link. The HTTPS
   in-page scanner offers Cancel and a manual fallback on camera denial;
   closing it stops the camera. Mint a fresh code if expired or already used.
3. Check the actual granted scopes and ceiling. Pairing opens sessions;
   **Set up** remains available. Open a session or create one, choose a
   workspace on the environment and send a prompt.
4. Answer a waiting permission card with Allow/Deny. The restricted `phone`
   preset includes `runs:drive` for answering, including asks from another client's run.
   If disconnected, reconnect and check the session before retrying actions.

At phone widths, use the session drawer and pane sheet. Files, Diff and
terminals require `terminal`; Settings writes and provider sign-in require
`admin`. Missing scopes show a reason and require deliberate re-pairing.
Switching sessions or closing a pane does not stop environment work. HTML/SVG
preview is a static sandboxed snapshot; use desktop for active preview scripts.

To add another HTTPS environment directly, its trusted admin must put this
client's exact origin, including port, in **Your machines > Allowed client
origins**. The serving environment's admin must also add the destination to
**Allowed connection origins**. Save both lists and reload the browser client to apply its connection
permissions before pairing. HTTP targets,
wildcards and unapproved origins are rejected; Tailscale access alone does
not grant cross-origin browser access.

## Provider sign-in and Settings

The restricted `phone` grant cannot change provider accounts or environment
settings. A trusted admin can configure them from another client, or you can
deliberately re-pair with **More options → Custom** + `admin` or **Me**
(`--preset own-client`). With that grant, choose the
environment in **Settings**, open **Accounts**, and choose **Sign in** (also
available in **Set up**). Tap the verification link to open the provider's
real page, complete it, return to the client, paste the returned code and
send it. Follow streamed done/failed/expired status; returning resumes status.
Use the displayed terminal fallback on the environment machine if needed.
Provider credentials stay with the environment, not in browser storage.

## Remembered pairing and a lost phone

Tokens use a separate origin-scoped IndexedDB store; client documents, cursors
and outbox use their own store. Tokens are JavaScript-readable, without the
OS protection of desktop secrets, and never belong in URLs, logs or worker
caches. Reload normally remembers a connection. Storage denial shows **pair
for this visit** and keeps credentials in memory; closing the visit loses them.
Cleared/evicted storage requires a fresh pairing code. A different hostname or
port is a different origin and does not reuse the saved credential.

**Forget** erases the local credential and attempts remote revocation. If the
environment is unreachable, use a trusted client's
**Settings → Settings rows → Access** to revoke it remotely when reachable.
For a lost phone, revoke every affected
browser/Home Screen client there; removing a Home Screen icon is not remote
revocation. Session tokens are refreshable and have a 30-day lifetime;
revoked or expired credentials require re-pairing.

## Add to Home Screen and update

- **iPhone/iPad:** open the HTTPS client in Safari, tap Share, **Add to Home
  Screen**, select **Open as Web App** when offered, then Add. Open the new
  icon. See [Safari guidance](https://support.apple.com/guide/iphone/iph42ab2f3a7/ios).
- **Android:** open in a supported browser such as Chrome, use the client’s
  **Install client** offer or the browser menu's **Install / Add to Home
  Screen** (current Chrome: **Install and create shortcut > Install**).
  Follow its prompts. If only a shortcut is available, keep using the tab;
  installation and push support depend on the browser. See
  [Chrome guidance](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid).

The installed client may have independent storage. Pair again with a fresh
code there if asked; installation never copies a tab's credentials. Keep
Tailscale connected to open sessions. A worker caches public versioned assets
and an offline shell, not authenticated traffic or tokens, and does not run
sessions. When a new client bundle is available, the client offers **Reload**
and retains the draft; it does not force a reload while composing. This is
separate from the environment's **Update now**.

## Enable notifications or use the Matrix fallback

Notifications are opt-in. On supported iOS/iPadOS 16.4 or later, Web Push
requires the installed Home Screen web app and a tap to request permission;
it is not promised in every browser tab. See
[WebKit's push requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

Open the paired client, open a session, then **Settings > Attention** (bell
button). Tap **Enable push** and allow the OS/browser request. Tap **Test push**
and check the notification; **Disable push** removes this client's registration.
Giving the phone full access later (or pairing it again in place) keeps push
on: the client registers itself again for its new pairing. Where the browser
needs a tap for that, the client says push is off; tap **Enable push** there.
If permission is denied, the client explains it rather than repeatedly asking.
Change the OS/browser permission explicitly to retry, or select **Use fallback**
for an available configured webhook route. The fallback list shows delivery
status/failure. A client paired with the admin grant adds the route itself (see
below); any other client asks an admin when none is configured or a global
route is disabled. A read-granted client can manage its own targets, not
global routes.

The environment sends the generic **A session needs you** with an HTTPS
session link after an ask has waited six seconds; answers/expiry cancel queued
work. Lock-screen payloads contain no transcript, prompt, secrets or session
title. Push goes through the browser vendor's gateway and needs internet
egress from the environment. Receiving does not require background tailnet
access; opening the private session does. In-app Parked asks help while
connected but cannot alert a closed browser. Routine completion alerts are
opt-in and silent outcomes stay quiet.

### Operator recipe: signed webhook to Matrix

An admin adds the route from a client paired with the admin grant (the
**Me** choice, CLI `--preset own-client`): **Settings > Attention** (bell
button), **Add a webhook route**. Type a name (lower-case letters, digits and hyphens, such as
`phone-attention`), the receiver's URL and a dedicated signing secret, then
**Add route**. The environment keeps the endpoint under that name, with its
secret in its vault, and adds a global route naming it, shown as **Signed
webhook · Global route**. Tap **Test** on that route to post a signed test to
the receiver and read the status it answered. A new route is
saved disabled and enabled only once its endpoint is saved; an endpoint the
environment refuses (an `http` URL to an internet host, a denylisted host)
takes the new route away again. A name another endpoint already has, such as
a routine's, is refused rather than replaced, and adding a route's own name
again replaces its URL and secret, which finishes a route left disabled.

To remove the fallback completely, tap **Remove** on its global route in
**Settings → Attention**. The environment removes that route and, when no
routine or other attention route names its endpoint, the named endpoint and
its saved signing secret too. The confirmation remains visible after the
row disappears and says what was removed. If a routine (even a disabled one)
or another route still names it, the confirmation says the endpoint and
secret were kept. For complete cleanup of a shared endpoint, remove its
uses in routines and other routes before removing the final global route. An endpoint backed by a key-manager reference loses its
reference here; the external secret itself stays in the key manager.

There is no `agent-harness attention` CLI verb. A script can make the same
two calls over the authenticated wire with an admin token:

```text
routines.endpoints.set
  commandId: <fresh-command-id>
  name: phone-attention
  url: https://<receiver>/attention
  secret: { kind: pasted, secret: <dedicated-shared-secret> }
attention.routes.set
  commandId: <another-fresh-command-id>
  target:
    id: phone-fallback
    transport: webhook
    enabled: true
    completion: false
    configuration: { endpoint: phone-attention }
```

Replace placeholders privately; never put credentials in reports. The
endpoint secret is held in the environment's secret store, not returned in
status. Configure the receiver to verify Standard Webhooks signatures
(`webhook-id`, `webhook-timestamp`, `webhook-signature`) and deduplicate by
`webhook-id`, then forward only the generic message and session URL to the
intended Matrix/Element X destination. Where a receiver uses `deliver_only`
and `deliver_extra.chat_id`, configure a dedicated attention-only route
with that explicit destination; do not rely on a default log room. Adapt
signature/schema handling if its protocol differs. This is receiver-side
configuration, not a new native chat adapter in agent-harness.

Test a waiting ask end to end with the phone client closed and record that
it reached the intended destination. A signed receiver double in hosted CI
proves sender behavior, not your live receiver, destination or phone alerts.
Use **Refresh status** in Attention to inspect failed/unavailable routes;
**Use fallback** selects an available route without creating a live receiver.

## Troubleshooting

| Symptom | Check or recovery |
| --- | --- |
| Cannot open the client | Tailscale connected on phone and environment, tailnet policy for HTTPS port, correct MagicDNS name/port, valid certificate and Serve proxy. Do not bypass certificate errors. |
| Link points to HTTP or the wrong port | Configure `--web-origin`/`AGENT_HARNESS_WEB_ORIGIN` in the running environment (for a container, in the `.env` file beside `compose.yaml`, then `docker compose up -d`), restart safely and mint a fresh code. Forwarded headers are not configuration. |
| Code expired/used | Mint a new one; each lasts ten minutes and works once. Use the address plus code if scanning fails. |
| Pairing forgotten | Same origin? Storage cleared, denied or evicted? Check **pair for this visit**; use a new code in the installed client if it has separate storage. |
| Settings, sign-in, Files or terminal unavailable | Check actual scopes. Use a trusted client or deliberately re-pair with the required `admin`/`terminal` grant. |
| Send cannot start a run | Check environment connection, provider account sign-in and workspace; signing into a provider is distinct from pairing the client. |
| Extra environment rejected | Both exact-origin lists must be saved by trusted admins; include HTTPS port, reject mixed HTTP. |
| No installation/camera/clipboard offer | Use HTTPS and a supported browser; check denied permissions. Manual links, file picker and ordinary copy/paste remain fallbacks. |
| No notification | Installed app requirement, OS permission/focus settings, enabled subscription, environment gateway egress, Attention failure status and fallback destination. Test in an open session first. |
| Notification opens but session cannot load | Reconnect Tailscale, check the origin and grant; revoke/re-pair if the credential expired or was revoked. |

For evidence to collect, use the
[web-client checklist](agents/web-client-checklist.md). Hosted tests do not
establish phone-proven status; the handset checklist in #1556 records it.
