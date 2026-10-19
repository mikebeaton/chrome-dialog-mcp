# Chrome Dialog Provenance MCP — capture flow specification

## Purpose and scope

Enable the agent to handle anticipated Chrome JavaScript dialogs using browser-reported provenance. The broker records events and controls response eligibility; the agent verifies the expected origin, message and user authorisation. Normal browser interaction remains with Computer Use.

Only dialogs anticipated before their triggering operation are supported. Unexpected/background dialogs, general asynchronous recovery, file pickers and browser permission prompts are outside scope. Counting events does not prove that an operation caused a particular dialog.

## Supported sequence

1. Call `launch_chrome()` and select the managed window using its Windows identifiers.
2. A fresh window displays `assets/start.html` directly as a local file within the MCP installation. The user manually navigates once to a valid URL in its address bar and leaves it open. Wait for confirmation before Computer Use capture. This bootstrap was validated with Google; startup navigation and scripted redirects did not substitute for it.
3. Observe the page. Immediately before the anticipated dialog-producing operation, call `start_dialog_capture()` and retain its capture token.
4. Perform that operation without automatic post-action Computer Use capture.
5. Call `get_captured_dialog(capture_id)` exactly once. The read seals and consumes the capture interval.
6. Only a successful capture supplies provenance and a response ID. Verify URL, type, message and the user's authorisation before responding to that ID.
7. Confirm `get_dialog_status()` returns `no_dialog` before resuming Computer Use input or capture.

On a failed capture, the agent stops handling attempts and informs the user, including the observed count if supplied. It does not respond, silently re-arm, repeat the operation or use a fallback lookup. The user resolves any remaining dialog. This stops the operation attempt, not the conversation turn.

Computer Use capture while a native dialog is pending can end the turn because it cannot establish the browser URL. The MCP offers no general recovery from that stop. Its startup instructions do not change Computer Use policy or replace per-dialog authorisation.

## Architecture

- **Chrome:** A reusable Windows Chrome with a dedicated profile and loopback remote debugging. New instances open the bundled local instruction file, or an optional configured HTTP(S) URL. Reused instances keep their current page.
- **Broker:** A persistent process owns CDP observation and event records. Only explicit `launch_chrome()` starts it on demand or establishes/re-establishes observation.
- **Adapter:** A stdio MCP server delegates to the authenticated local IPC broker. Adapter initialisation/exit does not start/close Chrome. Multiple adapters can share a broker without acquiring ownership.

The broker exposes no general CDP operations. Debugging endpoints, profile paths and CDP target/session IDs remain internal. IPC protocol v2 rejects legacy brokers rather than falling back to their previous response semantics.

## Tools

### `launch_chrome()`

Ensures the intended Chrome exists and its observer is ready before returning `ready` with `pid`, `hwnd` and `windows_session_id`. Unavailable identifiers are `null`. It validates persistent process identity rather than attaching to arbitrary Chrome. Repeated ready launches reuse the connection and window. Only explicit launch may establish a new connection after loss.

The tool guidance explains the manual address-bar step for fresh windows and requires waiting for the user's confirmation before Computer Use capture. Window identifiers are selection hints, not evidence of RDP visibility. No focus operation is provided.

### `get_dialog_status()`

Returns `not_connected`, `no_dialog`, or `dialog_pending` with `pending_count`. No response ID or provenance is supplied. This read neither arms nor consumes capture and never authorises a response.

### `start_dialog_capture()`

Requires a connected observer with no already-pending dialog. Returns:

```json
{"status":"capturing","capture_id":"f7142ce8-3745-47f3-96ca-c2628b601e2f"}
```

The UUID identifies an observation interval on the current uninterrupted connection. Every observed `Page.javascriptDialogOpening` across the managed browser increments its count, including events whose dialog subsequently closes, is replaced or loses its target/session. Unusable provenance cannot create a successful capture. Events before arming are excluded.

### `get_captured_dialog(capture_id)`

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

The URL is browser-reported provenance, not a claim from the message. Frame IDs are omitted. `dialog_id` is a broker-assigned, durable monotonic sequence distinct from the capture UUID.

For zero or multiple openings:

```json
{"status":"incorrect_dialog_count","expected_count":1,"observed_count":2}
```

Exactly one opening whose dialog is no longer pending/attributable returns `dialog_not_pending`. An unknown or consumed token returns `invalid_capture`; absent observation returns `not_connected`. Failures release no response ID or permission and are marked as MCP errors. Count errors describe the observation without alleging an attack.

### `respond_to_dialog(dialog_id, action)`

Accepts `accept` or `dismiss`. Requires a successful capture that released this ID and the agent's independent verification of origin, expected operation and user authorisation. Known origin alone does not authorise the action.

The broker enforces response eligibility. Guessing an observed but uncaptured ID returns `dialog_not_captured` without sending a response command. Unknown, closed, replaced or consumed IDs return `stale_dialog`. It checks current connection, pending-record identity and target/session before consuming the ID and sending CDP's response command. A replacement after successful inspection still invalidates the previous ID.

CDP's handling command itself accepts no dialog ID. The broker enforces association using events it has observed; it cannot make Chrome's command and external user activity atomic. An ambiguous command failure invalidates observation rather than allowing a retry.

### `close_chrome()`

Explicitly closes only the managed instance. Graceful CDP shutdown is preferred; verified process-tree termination is the fallback. It invalidates captured state even if close fails. Ordinary task/adapter completion does not close the reusable browser.

## Connection and concurrency rules

- Observer subscriptions are ready before launch succeeds. A pre-existing dialog that blocks setup causes failure without handling that dialog.
- Connection loss immediately invalidates all capture tokens, records, response IDs and permissions. Before first connection and after loss, dialog tools return the same `not_connected` status.
- No automatic CDP reconnect, retries, provenance reconstruction or revalidation. Only a new explicit launch starts fresh observation. Old state never becomes usable again; dialog sequence IDs are not reused after broker restart.
- Broker requests are serialised; incoming CDP events continue updating state while commands are in flight.
- Independent captures may overlap. Each counts all openings during its own interval. Captures and launches grant no exclusive browser ownership.
- There are no agent locks, leases, heartbeats, idle timeouts or automatic task-end cleanup. Shared mouse/keyboard activity can interfere with an operation.

## Tool guidance and validation

Server instructions and tool descriptions contain the supported sequence, manual startup navigation, independent provenance/authorisation checks, single-use reads, and the requirement to stop handling and inform the user after capture failure. A failed count cannot be bypassed through a latest-dialog lookup; that operation is removed.

Tests cover zero/one/multiple openings, closed and identical replacement dialogs, separate capture/response IDs, guessed IDs, replay, target/session changes, connection loss, explicit reconnect, two adapters, IPC authentication, process identity and explicit close. Installed-Chrome integration uses a separate test driver to simulate human replacement and verifies no broker response command is sent on count failure. Manual Computer Use validation of this capture flow and blind user intervention is recorded separately from automated integration.
