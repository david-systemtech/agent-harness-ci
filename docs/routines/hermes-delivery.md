# Routine results to Matrix through Hermes

Milestone 1 uses Hermes as the delivering endpoint, as decided in #29 and ADR 0008: the harness posts a signed webhook, and Hermes relays it to the Matrix home room. No Hermes state is read or imported. Hermes keeps its bots and schedules until milestone 2; the netdata alerts retain their own route on the same adapter.

The repository work for #538 adds `hermes` on `success` to the [disabled upstream-watch definition](upstream-watch.md). Client notices remain on `both`. This does not configure Hermes, Matrix/Tuwunel, OpenBao or a live environment. The live checks below are tracked in [#1009](https://git.systemtech.dev:5526/david/agent-harness/issues/1009), coordinated with the upstream-watch cut-over [#988](https://git.systemtech.dev:5526/david/agent-harness/issues/988). The fleet must be available first (cortex issue 437).

## Receiver contract

Configure a dedicated Hermes webhook route that **only delivers** to the home room: no model turn, tool execution or schedule. Keep the existing netdata route and secret separate. Record the actual route URL and room id during setup; this repo assumes neither.

The route must accept signed JSON POSTs of `routine.test` for endpoint testing and `routine.result` version 1 for results. A result carries `environment` and `routine` ids/names, `entry` (id, kind, trigger, due/start/end times, outcome, reason and session id), `summary` and `text` (at most 16,000 characters). Render the summary/text as message data, not instructions. Do not require a session id for a skip. A non-silent successful upstream-watch firing is sent; failure stays on the client notice. No-change and silence send nothing.

Verify the raw request body **before relaying** using Standard Webhooks:

- Headers: `webhook-id`, `webhook-timestamp`, and space-separated `webhook-signature` entries of form `v1,<base64 signature>`.
- HMAC-SHA256 input: `<webhook-id>.<webhook-timestamp>.<raw body>`, signed with the shared secret's bytes, or decoded base64 bytes after `whsec_` for that secret format. Compare signatures in constant time; accept any valid supported signature.
- Accept timestamps within 300 seconds of the receiver clock, in either direction; reject missing/invalid signatures, modified bodies and older or future requests outside that window. Keep clocks synchronized.
- Deduplicate authenticated messages by `webhook-id`, not timestamp or body: every retry has the same id but a fresh timestamp/signature. Remember delivered ids across a receiver restart and at least through the full retry horizon (1 + 5 + 30 minutes plus the replay window). Commit a delivered id only after successful Matrix delivery; handle concurrent duplicates. A Matrix failure must remain retryable. Receiver crash recovery during a Matrix send also needs verification; an in-memory set alone cannot establish delivery once across restarts. The pinned receiver's two accepted milestone-1 gaps are recorded below; they do not satisfy this contract.
- A 2xx acknowledges delivery. The harness follows no redirects and times out each attempt after ten seconds. Network errors, timeouts, 408, 429 and 5xx retry after 1, 5 and 30 minutes, surviving a harness restart. Other statuses fail finally; unresolved key-manager references also retry. A final failure raises `routine.delivery-failed` to clients.

## Known gaps on the pinned Hermes

Hermes `v2026.9.24` has two known delivery gaps:

- **Deduplication is lost across a Hermes restart.** Seen webhook ids are kept in memory. A retry with the same `webhook-id` after the receiver restarts can post a second Matrix message.
- **A failed Matrix send is counted as delivered on a later retry.** The receiver records the webhook id before sending to Matrix. A failed send returns 502 but leaves the id recorded; a later retry returns 200 `duplicate`, and the harness records delivery even though the room received no result.

David explicitly accepted these two gaps on **2026-10-02** for **milestone 1**, because the image is pinned and Hermes is temporary. The [decision on #1009](https://git.systemtech.dev:5526/david/agent-harness/issues/1009#issuecomment-25558) accepts them as known gaps, not passing checks. Keep the pin; this checklist does not call for a local image patch. Any other failed signature or retry check still blocks acceptance, including replay-window rejection, a lost-acknowledgement retry without a receiver restart, and concurrent duplicate handling. An unrun check is owed evidence, not an observed gap or a pass.

[#1009](https://git.systemtech.dev:5526/david/agent-harness/issues/1009) remains the owner of live verification and filing **both** gaps upstream. This repository update performs no live delivery and changes no server.

### Record the observations

Use the switch-over acceptance-record template from [#1195](https://git.systemtech.dev:5526/david/agent-harness/issues/1195), on the SYSTEM-MNL Hermes row linked to the SYSTEM-SERVER Environment. Record the observed deployment version as `v2026.9.24`, the operator/date and sanitized #1009 evidence links. If the observed version differs from the pin, do not carry this acceptance forward automatically.

Give each gap its own observation: the entry id, stable webhook id, attempt timings/statuses, whether Hermes restarted or the Matrix send failed, and the room's message count/ids. For the failed-send case, record both the receiver's 502 then 200 `duplicate` and the harness history's delivered status alongside the absent Matrix result; HTTP/history success alone is not proof of delivery. Mark each as **known gap, pinned Hermes**, with what was actually observed, David's explicit milestone-1 acceptance dated 2026-10-02, and the #1009 decision and live-evidence links. Keep upstream issue links in that evidence when filed. Do not include secrets, signatures or private result bodies. Missing observations remain owed; the decision alone supplies no live evidence.

### Synthetic acceptance-record review

This example uses invented ids and observations to review the template; it is **not live evidence**. Deployment: SYSTEM-MNL Hermes `v2026.9.24`, linked Environment: SYSTEM-SERVER, operator/date: example operator, 2026-10-02. Each evidence placeholder must be replaced with a sanitized #1009 live-check link before sign-off.

| Check | Synthetic observation | Acceptance-record disposition | Evidence |
| --- | --- | --- | --- |
| Deduplication across a Hermes restart | Entry `example-restart`, webhook id `example-restart-id`: attempt 1 relayed at 10:00 UTC; a lost acknowledgement caused retrying. Hermes restarted; attempt 2 at 10:01 used the same id and returned 200. The room has two messages, `example-message-1` and `example-message-2`. | Known gap, pinned Hermes; accepted by David on 2026-10-02 for milestone 1 because the image is pinned and Hermes is temporary. This check failed. | [#1009 decision](https://git.systemtech.dev:5526/david/agent-harness/issues/1009#issuecomment-25558); live observation owed. |
| Retry after a failed Matrix send | Entry `example-send`, webhook id `example-send-id`: attempt 1 at 10:05 UTC failed its Matrix send and returned 502. Attempt 2 at 10:06 used the same id and returned 200 `duplicate`; harness history says delivered, but the room has zero messages for this entry. | Known gap, pinned Hermes; accepted by David on 2026-10-02 for milestone 1 because the image is pinned and Hermes is temporary. This check failed. | [#1009 decision](https://git.systemtech.dev:5526/david/agent-harness/issues/1009#issuecomment-25558); live observation owed. |
| Wrong signature | At 10:10 UTC a request with a wrong signature returned 200 and was relayed to the room as `example-message-3`. | Blocking failure; outside the two accepted gaps. No milestone-1 acceptance. | Live signature-rejection evidence and resolution owed to #1009. |

Review result: the first two rows disclose accepted failures rather than passes. The wrong-signature row still blocks acceptance even with those gaps accepted. With that row resolved, this synthetic record would still supply no live proof: the operator must fill #1195's record with actual observations and all required evidence, and David must sign acceptance.

## Endpoint setup with David

1. Put the route's secret in OpenBao under `personal/agents/endpoint-hermes`, field `secret`, or record the actual locator under `personal/agents/`. Give the SYSTEM-SERVER environment's configured connection access to that field. Use the same value at the receiver. Never put a real value in this repo, tracker, command arguments or logs.
2. From an authenticated client connected to **SYSTEM-SERVER**, with `admin`, configure the endpoint named exactly `hermes`. Use HTTPS or an allowed tailnet URL without userinfo. #536 is merged, so use a reference resolved on every test/delivery; do not leave the final endpoint with a pasted secret. If a temporary paste is needed, move it through the Key manager's Move source to `<base>/endpoint-hermes`, with base `personal/agents`, and check the displayed locator afterwards.
3. The GUI endpoints pane may be used if available. Otherwise use the typed client's `request` interface, with values selected from that environment's key-manager connection and actual Hermes route:

```ts
await client.request("routines.endpoints.set", {
  commandId: crypto.randomUUID(),
  name: "hermes",
  url: hermesRouteUrl,
  secret: {
    kind: "reference",
    reference: {
      provider: "openbao",
      connectionId: openBaoConnectionId,
      mount: "personal",
      path: "agents/endpoint-hermes",
      key: "secret",
    },
  },
});
await client.request("routines.endpoints.list", {});
await client.request("routines.endpoints.test", { name: "hermes" });
```

Check the set's receipt is accepted and list shows `secretKind: reference`, the right URL and display locator, with no secret value. The endpoint test must answer 2xx with no error **and** its test message must appear once in the home room; HTTP success alone is insufficient.

## Attach the watch and prove a retry

1. Coordinate with #988 before enabling or replacing a live routine. The committed YAML imports disabled with the success webhook already present. Inspect `routines.checkImport` warnings before import. For a watch already imported with client delivery alone, use `routines.list` to select its id and `routines.update` with only `fields.delivery`: preserve every existing target and add `{ kind: "webhook", target: "hermes", on: "success" }` once. Keep the client notice on `both` and preserve the disabled state until the cut-over. Do not re-import an old document over live field edits.
2. Use `routines.runNow` on that id for a known non-silent successful result. Preserve issue #74's ledger; the first empty-ledger observation may bootstrap silently, and an unchanged pre-check may skip. Do not fabricate a digest or reset the ledger to force delivery. Verify one result in the home room, its entry id/session and successful delivery in `routines.history`. Also verify failure reaches the client notice, and silence/no-change reaches no room message.
3. Arrange one controlled 5xx **after the receiver accepted and relayed a result**, simulating a lost acknowledgement. The harness should record attempt 1 as `retrying`, then attempt 2 after one minute with the same `webhook-id`, a refreshed timestamp/signature, and 2xx. Verify history shows both attempts and the room has exactly one result. Separately force a Matrix-send failure before acceptance, and observe whether recovery delivers or is swallowed by the deduplication record. Check a receiver restart and concurrent duplicate handling. Record the two pinned-Hermes gaps under the known-gap rules above; all other failures still block acceptance. Remove fault injection and confirm netdata still delivers through its own route.
4. Record sanitized endpoint display, status, entry id, attempt timings, stable webhook id and Matrix message ids/count in #1009 and link that evidence from #1195's acceptance record, including each known gap and its explicit acceptance. File both gaps upstream through #1009. Verify signature rejection and replay-window checks on the actual adapter; the loopback tests do not certify Hermes or a real Matrix server.
5. Update the upstream-watch memory and the Hermes-plan memory: the watch runs on the harness; successful results use endpoint `hermes`, a Standard Webhooks route that only delivers to the Matrix home room, with a reference under `personal/agents/` and stable-id deduplication. Record the actual route, locator and test evidence without secrets. Hermes's bots and schedules stay until milestone 2, and nothing is read or imported from Hermes.
