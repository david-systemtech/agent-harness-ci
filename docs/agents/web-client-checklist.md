# Web client: automated evidence and handset checklist

Use [the phone guide](../phone.md) to configure and connect; the design is
[web-client.md](../specs/web-client.md). Record the release version, commit,
date, device/OS/browser versions and the outcome of each applicable check.
Use placeholders for private addresses and identities; never attach pairing
codes, QR images, tokens, endpoint secrets, provider credentials or private
transcripts. Redact screenshots before attaching them.

Repository builders use tests and hosted CI only. The coordinator handles
staged deployment, certificates, tailnet policy and live receiver routing.
#1556 is the single handset evidence ticket; provider sign-in evidence reuses
#1492. Neither human check blocks builders or a release. Until dated handset
results are attached, call the client automated-tested, not phone-proven.

## Hosted automation: what it can prove

Record run links and the tested head. Mark each row passed, failed or not run;
this list is an evidence requirement, not a claim that every current release
has passed it. #1539 supplies the packaged real-browser conversation smoke;
#1555 extends hosted regressions. Gallery scenes prove rendering/geometry
with fixtures, separately from real-browser environment integration.

| Boundary | Evidence to record |
| --- | --- |
| Packaged client | Server archives (packed and unpacked) and container build output contain the matching-version client assets; `/` and `/pair` serve, API misses/traversal stay rejected. |
| Real browser | Hosted Chromium and WebKit phone viewports use the real bundle and an isolated real environment under an ordinary uid, with a scripted provider. No owner account or tailnet is required. |
| Pairing | Link/CLI QR advertises configured HTTPS origin including port; Phone and My own client retain exact grants. Reload/refresh remembers tokens; storage denial/eviction and revocation have usable outcomes. |
| Conversation | Prompt streams, permission Allow/Deny answers once, reconnect/replay recovers; missing scope rejects operations. Scripted Settings/provider sign-in with constrained/full grants. |
| Multiple environments | Approved exact client/connect origins permit discovery/pair/preflight/WebSocket and merged sessions; unapproved and mixed HTTP origins fail. |
| Phone surfaces | Narrow/enlarged-text/keyboard-height scenes assert no page overflow, 44px targets, visible Send/Allow/Continue, drawer/sheet focus and notices clear of composer. Panes and sandboxed HTML/SVG isolation have tests. |
| Installation/update | Manifest/icons, public-only worker cache, reload offer with retained draft, no authenticated traffic/tokens cached. |
| Closed-client attention | Encrypted push to a test gateway with page closed; notification click uses same-origin session route. Subscription revocation/expiry/404/410 and permission denial/unavailable fallback. Signed webhook receiver doubles verify payload, signature, retries, deduplication and cancellation. |
| Compatibility | Existing desktop/TUI pairing and release-asset regressions pass alongside the phone tests. |

Do not run a browser, dev server, Electron or container on the shared agent
box. Hosted CI runs integration/packaging checks. It proves mechanics against
scripted providers, gateways and receivers, not actual account authentication,
OS notification delivery, certificate renewal or a live Matrix destination.
There are no new gallery scenes for a documentation-only change.

## Coordinator deployment checks

- [ ] Choose a release containing the phone client; record deployed version
  separately from the repository head and hosted test version.
- [ ] Inspect existing Serve configuration, choose a free HTTPS port and retain
  other services. Configure the exact `--web-origin` (or service/container
  `AGENT_HARNESS_WEB_ORIGIN`) with a valid managed certificate. No Funnel.
- [ ] Verify HTTPS root/assets, same-origin `/ws`, correct Host/Origin handling
  through the proxy, canonical links with port, and certificate renewal setup.
- [ ] Verify phone tailnet policy permits that HTTPS port on mobile data.
- [ ] Configure and test the dedicated signed webhook attention route and its
  intended Matrix destination. Record signature/schema adaptation if needed.
  A routine webhook or default log room alone is not closed-phone fallback.

## Handset evidence: what only the actual phone proves

Run these on the installed candidate, including mobile data with Tailscale
connected. Record actual OS permission outcomes and failures in #1556. Use
fresh codes for each browser/Home Screen pairing and revoke test clients after.

- [ ] Open the configured HTTPS root; scan a fresh CLI/desktop QR with the OS
  camera, then exercise manual address/code entry. Try in-page camera Allow,
  Deny and Cancel; confirm its camera indicator stops after closing.
- [ ] Pair **Phone**: displayed `read`, `sessions:write`, `runs:drive` and
  `acceptEdits`. Send a real prompt with an already signed-in provider account,
  stream a reply and answer a permission card. Files/terminal/admin controls
  explain their missing grant.
- [ ] Separately pair **My own client**: every scope and `bypassPermissions`.
  Confirm the browser retains this grant, with no downgrade. Deliberately
  re-pair a Custom code with admin/terminal at `acceptEdits` and check the
  replacement confirmation; the phone cannot self-raise its grant.
- [ ] With admin, open Settings/Accounts and Set up. Open the real verification
  page, return to paste its code and follow status. Attach provider sign-in
  evidence to the existing #1492 request and reference it here; do not create
  another authentication ticket.
- [ ] Open another approved HTTPS environment; switch sessions and use Files,
  Diff, Documents, Tasks and terminal with the explicit grants. Confirm runs
  and terminals continue while their panes or the client are hidden.
- [ ] Exercise keyboard show/hide, orientation, safe areas/notch, enlarged text,
  pinch zoom, IME, touch selection and terminal Ctrl/Esc/Tab. Send/Allow/Deny
  and Set up Continue remain reachable; long content does not overflow.
- [ ] Background/resume and close/reopen the browser: the session reconnects,
  pairing is remembered where storage permits and permission answers do not
  duplicate. Clear storage once and verify fresh pairing recovery.
- [ ] Follow iPhone/iPad Safari Share > Add to Home Screen / Open as Web App,
  or Android Install / Add to Home Screen. Open the icon and record whether
  pairing storage is separate; use a fresh code when needed. Exercise a
  client update Reload offer with a draft and verify it survives.
- [ ] From a session, tap Enable push and Test push. Record unavailable/denied
  outcomes as well as allowed. On iOS/iPadOS, use the eligible Home Screen
  app. Check background/closed/locked-screen delivery under actual OS settings.
- [ ] Tap the notification over mobile data with Tailscale on: it opens the
  intended session on the same HTTPS origin. Check behavior with Tailscale off,
  then reconnect. Record the generic lock-screen text without private content.
- [ ] Select the configured webhook fallback when push is denied/unavailable.
  With the web client closed, park an ask and verify the generic message/link
  reaches the intended Matrix/Element X destination, then open that session.
  Distinguish receiver success from an actual phone notification.
- [ ] Revoke the phone's browser and Home Screen credentials from a trusted
  client's Access row. Both lose authority; a fresh code restores access.
  Check Forget locally, including the unreachable-environment explanation.

Record the owner's decisions on the advertised address/port, restricted or
explicitly expanded grant, generic lock-screen text, fallback destination and
phone layout/text size. These confirmations do not change the build defaults
or block shipping. File ordinary defects for failures, with redacted evidence.
