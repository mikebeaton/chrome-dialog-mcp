# Chrome Dialog Provenance MCP — capture flow specification

## Purpose and scope

Enable the agent to handle anticipated Chrome JavaScript dialogs using browser-reported provenance. The broker records events and controls response eligibility; the agent verifies the expected origin, message and user authorisation. Normal browser interaction remains with Computer Use.

Only dialogs anticipated before their triggering operation are supported. Unexpected/background dialogs, general asynchronous recovery, file pickers and browser permission prompts are outside scope. Counting events does not prove that an operation caused a particular dialog.

## Supported sequence

1. Call `launch_chrome()` without a token to create a new managed browser session. Keep the returned `browser_token` private and supply it on every subsequent call. Select that session's window using its Windows identifiers. Reuse requires explicitly supplying an existing token to `launch_chrome`; never silently adopt another agent's browser.
2. A fresh window displays `assets/start.html` directly as a local file within the MCP installation. Ask the user to choose any valid website themselves and manually type its address into that window's address bar, wait for it to load, leave the window open and confirm when done. Do not supply or suggest a bootstrap URL or ask them to paste an agent-provided address. Wait for explicit confirmation before Computer Use input or capture. Agent-provided addresses failed in user trials where a subsequent manually entered, user-chosen address worked; the underlying cause remains unverified. Startup navigation and scripted redirects did not substitute for the manual step.
3. Observe the page. Immediately before the anticipated dialog-producing operation, call `start_dialog_capture(browser_token)` and retain its capture token.
4. Perform that operation without automatic post-action Computer Use capture.
5. Call `get_captured_dialog(browser_token, capture_id)` exactly once. The read seals and consumes the capture interval.
6. Only a successful capture supplies provenance and a response ID. Verify URL, type, message and the user's authorisation before responding to that ID.
7. Confirm `get_dialog_status(browser_token)` returns `no_dialog` before resuming Computer Use input or capture.

On a failed capture, the agent stops handling attempts and informs the user, including the observed count if supplied. It does not respond, silently re-arm, repeat the operation or use a fallback lookup. The user resolves any remaining dialog. This stops the operation attempt, not the conversation turn.

Computer Use capture while a native dialog is pending can end the turn because it cannot establish the browser URL. The MCP offers no general recovery from that stop. Its startup instructions do not change Computer Use policy or replace per-dialog authorisation.

## Architecture

- **Chrome:** Each managed session has a separate Windows Chrome process/profile and loopback remote debugging endpoint. New instances open the bundled local instruction file, or an optional configured HTTP(S) URL. Explicit reuse retains the current page and never launches a replacement process.
- **Broker:** A persistent process owns a registry of browser sessions, each with independent CDP observation and dialog state. Only explicit `launch_chrome` starts the service on demand or establishes/re-establishes observation. All sessions share a durable monotonic dialog sequence.
- **Adapter:** A stdio MCP server delegates to the authenticated local IPC broker. Adapter initialisation/exit does not start/close Chrome. Multiple adapters can use the service; browser sessions are separate unless their capability token is deliberately shared.

The broker exposes no general CDP operations. Debugging endpoints, profile paths and CDP target/session IDs remain internal. IPC protocol v4 rejects legacy brokers rather than falling back to a shared singleton without session isolation (v3), responses that ignore prompt text (v2), or missing capture eligibility (v1).

## Browser session capabilities

Each agent normally launches and retains its own Chrome process/profile. Separate sessions prevent implicit browser reuse when switching between agents, including sequential use; deliberate reuse or handover requires the existing token.

`browser_token` is a broker-generated random 256-bit value encoded as 64 lowercase hexadecimal characters. It grants access through possession; it does not authenticate an agent or chat identity. Every tool except creation of a new browser session requires it. There is no session listing or implicit adoption tool. Missing, malformed, unknown or revoked browser tokens return `invalid_browser_token` (schema validation may reject malformed/missing parameters before IPC).

Only new tokenless launch creates a profile/process. Supplying an existing token selects only that session. Capture tokens and dialog IDs are resolved solely in its dialog state; using another session's capture token returns `invalid_capture`, and using its dialog ID returns `stale_dialog`, without touching the original. Independent session event counts, connection loss and close operations do not affect one another.

Session metadata and process identity are persisted in a private directory named by the hash of the browser token. Saved tokens can be reused after service restart, but loading metadata neither launches nor connects to Chrome. Explicit launch with that token is needed to establish fresh observation; captures and response permissions are not reconstructed. Tokens whose original Chrome has exited cannot create a replacement. Successful close (including an already-exited process) durably revokes the token. A failed close invalidates observation but retains the token for explicit cleanup retry. Profiles and revocation metadata remain on disk.

## Tools

### `launch_chrome(browser_token?)`

Without a token, creates a new session, Chrome profile/process and observer. With a token, selects only that existing session and validates its persistent process identity rather than attaching to arbitrary Chrome or starting a replacement. Ready launches return `ready` with `browser_token`, `pid`, `hwnd` and `windows_session_id`; unavailable Windows identifiers are `null`. A failed initial launch returns `launch_failed` with its token for explicit cleanup of a possible process. Only explicit launch may establish a new connection after loss. Reuse with a valid token after the process has exited fails rather than opening another browser.

The tool guidance requires the user to choose and manually type the initial web address themselves, without an agent-supplied URL, and requires waiting for their explicit confirmation before Computer Use input or capture. Window identifiers are selection hints, not evidence of RDP visibility. No focus operation is provided.

### `get_dialog_status(browser_token)`

Returns `not_connected`, `no_dialog`, or `dialog_pending` with `pending_count`. No response ID or provenance is supplied. This read neither arms nor consumes capture and never authorises a response.

### `start_dialog_capture(browser_token)`

Requires a connected observer with no already-pending dialog. Returns:

```json
{"status":"capturing","capture_id":"f7142ce8-3745-47f3-96ca-c2628b601e2f"}
```

The UUID identifies an observation interval in that browser session on its current uninterrupted connection. Every observed `Page.javascriptDialogOpening` across all tabs/windows in that Chrome instance increments its count, including events whose dialog subsequently closes, is replaced or loses its target/session. Events in separate managed sessions do not count. Unusable provenance cannot create a successful capture. Events before arming are excluded.

### `get_captured_dialog(browser_token, capture_id)`

Seals and consumes the interval once, on success or failure. No polling or token replay is supported.

If exactly one opening was observed and that same attributable dialog is still pending on the same target/session and connection, returns:

```json
{
  "status": "captured",
  "dialog_id": 17,
  "url": "https://example.com/settings",
  "type": "confirm",
  "message": "Delete this item permanently?",
  "options": ["accept", "dismiss"]
}
```

The URL is browser-reported provenance, not a claim from the message. For prompts, `default_prompt` is also returned when Chrome supplies it; it is omitted for other types. Frame IDs are omitted. `dialog_id` is a broker-assigned, durable monotonic sequence distinct from the capture UUID.

For zero or multiple openings:

```json
{"status":"incorrect_dialog_count","expected_count":1,"observed_count":2}
```

Exactly one opening whose dialog is no longer pending/attributable returns `dialog_not_pending`. An unknown or consumed token returns `invalid_capture`; absent observation returns `not_connected`. Failures release no response ID or permission and are marked as MCP errors. Count errors describe the observation without alleging an attack.

### `respond_to_dialog(browser_token, dialog_id, action, prompt_text?)`

Accepts `accept` or `dismiss`. Requires a successful capture that released this ID and the agent's independent verification of origin, expected operation and user authorisation. Known origin alone does not authorise the action.

Accepting a `prompt` requires an explicit `prompt_text` string; `""` deliberately submits an empty value. The agent must verify that submitting that particular text is authorised. Missing text for prompt acceptance, non-string values, or text supplied for dismissal/other dialog types return `invalid_request` without acting or consuming a valid response ID. Prompt dismissal returns the page's normal cancellation result (`null`). Text is not echoed in the success response.

The broker enforces response eligibility. Guessing an observed but uncaptured ID returns `dialog_not_captured` without sending a response command. Unknown, closed, replaced or consumed IDs return `stale_dialog`. It checks current connection, pending-record identity and target/session before consuming the ID and sending CDP's response command. A replacement after successful inspection still invalidates the previous ID.

CDP's handling command itself accepts no dialog ID. The broker enforces association using events it has observed; it cannot make Chrome's command and external user activity atomic. An ambiguous command failure invalidates observation rather than allowing a retry.

### `close_chrome(browser_token)`

Explicitly closes only that session's Chrome instance and revokes its token on success. Graceful CDP shutdown is preferred; verified process-tree termination is the fallback. It invalidates that session's captured state even if close fails. Other sessions remain usable. An absent broker returns `not_connected`, not proof of Chrome exit. Ordinary task/adapter completion does not close the reusable browser.

## Connection and concurrency rules

- Observer subscriptions are ready before launch succeeds. A pre-existing dialog that blocks setup causes failure without handling that dialog.
- Connection loss immediately invalidates all capture tokens, records, response IDs and permissions in the affected browser session. Before first connection and after loss, its dialog tools return the same `not_connected` status. Other browser sessions are unaffected; a service restart loses observation in all sessions.
- No automatic CDP reconnect, retries, provenance reconstruction or revalidation. Only a new explicit launch starts fresh observation. Old state never becomes usable again; dialog sequence IDs are not reused after broker restart.
- Broker requests are serialised; incoming CDP events continue updating state while commands are in flight.
- Independent captures may overlap. Each counts all openings in its browser session during its own interval. Tokens grant access through possession; deliberately sharing one does not provide exclusive ownership within that session.
- There are no agent locks, leases, heartbeats, idle timeouts or automatic task-end cleanup.
- Dialog responses use the token-selected session's CDP connection and do not depend on desktop focus. Coordination of desktop mouse/keyboard input belongs to Computer Use and is outside this MCP's scope.

## Tool guidance and validation

Server instructions and tool descriptions contain the supported sequence, manual startup navigation, independent provenance/authorisation checks, single-use reads, and the requirement to stop handling and inform the user after capture failure. A failed count cannot be bypassed through a latest-dialog lookup; that operation is removed.

Tests cover isolated browser sessions, cross-session identifiers/counts, token validation/revocation/restart, zero/one/multiple openings, closed and identical replacement dialogs, separate capture/response IDs, guessed IDs, replay, target/session changes, connection loss, explicit reconnect, two adapters, IPC authentication, process identity and scoped close. Installed-Chrome integration uses two distinct processes/profiles and a separate test driver to simulate human replacement; it verifies no broker response command is sent on count failure. Manual Computer Use validation of the capture flow and blind user intervention is recorded separately from automated integration.
