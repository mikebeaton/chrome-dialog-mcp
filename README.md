# Chrome Dialog Provenance MCP

A Windows stdio MCP server for capturing Chrome JavaScript dialog provenance and responding to an identified dialog. Normal browser interaction stays with Computer Use; the agent checks origin and user authorisation.

Only **anticipated dialogs** are supported. The agent arms a capture before the known operation. A response ID is released only when exactly one opening was observed and that dialog remains pending.

## Workflow

1. `launch_chrome()` starts/reuses Chrome and establishes observation. New instances display the bundled [startup instructions](assets/start.html) as a local file; no page server is needed.
2. For a fresh window, the user manually enters a valid URL in its address bar once and leaves it open. Wait for confirmation before Computer Use capture. This bootstrap was validated with `https://www.google.com/`.
3. Select the returned window, observe the page, then call `start_dialog_capture()` immediately before the anticipated operation.
4. Perform the operation without automatic post-action Computer Use capture. Call `get_captured_dialog(capture_id)` once to seal the interval.
5. On success, verify URL, type and message against the operation and user instructions. Respond using its `dialog_id`, confirm `get_dialog_status()` returns `no_dialog`, then resume Computer Use.

Zero or multiple openings return `incorrect_dialog_count` with `expected_count: 1` and `observed_count`. Closed/replaced dialogs still count. A sole dialog that has closed returns `dialog_not_pending`. Every capture read consumes the token, including failures; it must not be polled.

After capture failure, stop handling attempts and tell the user what happened, including the count when supplied. No response ID is released, and guessing the pending ID cannot bypass capture. Do not silently re-arm, repeat the operation or use another handling path. Ask the user to resolve any remaining dialog. This stops that operation attempt, not the conversation turn.

Capturing a pending dialog through Computer Use can end the turn because its URL cannot be established. There is no general asynchronous recovery or push notification. The startup page does not change Computer Use policy.

## Run

Requires Windows, Node.js 24+, and Google Chrome.

```powershell
npm ci
npm start
```

MCP configuration: command `node`, argument `C:/OpenSource/chrome-dialog-mcp/src/adapter.js`. Standard output is reserved for MCP messages.

| Environment variable | Purpose |
| --- | --- |
| `CHROME_DIALOG_CHROME_PATH` | Optional Chrome executable path. |
| `CHROME_DIALOG_START_URL` | Optional HTTP(S) startup override; default is the bundled `assets/start.html` file. |
| `CHROME_DIALOG_STATE_DIR` | Private broker state directory; default `%LOCALAPPDATA%/ChromeDialogMcp`. Adapters using the same directory share one broker/browser. |

The persistent broker inherits settings when first started. Its state directory contains the IPC authentication key and dedicated Chrome profile; use a directory private to your Windows account. Protocol v2 rejects legacy brokers. Upgrading a running v1 installation requires stopping that broker before reuse, or selecting a fresh state directory.

## Tools

| Tool | Result |
| --- | --- |
| `launch_chrome()` | Starts/reuses Chrome and explicitly establishes observation. Returns `ready`, PID, HWND and Windows session ID; unavailable identifiers are `null`. Reuse retains the current page. |
| `get_dialog_status()` | `no_dialog`, `dialog_pending` with pending count, or `not_connected`. Returns no response ID or provenance. |
| `start_dialog_capture()` | Arms observation and returns a single-use `capture_id`; refuses an already-pending dialog. |
| `get_captured_dialog(capture_id)` | Seals the interval. Exactly one still-pending opening returns `captured`, `dialog_id`, browser-reported URL, type, message and accept/dismiss options. |
| `respond_to_dialog(dialog_id, action)` | Accepts/dismisses only a successfully captured, still-current dialog, once. |
| `close_chrome()` | Explicitly closes the managed browser, using graceful CDP shutdown or verified process-tree termination. |

Capture tokens and dialog IDs are distinct. Frame IDs, CDP endpoints, profile paths and CDP target/session IDs are omitted. Windows identifiers select the managed window; they do not prove RDP visibility.

Adapter startup/exit does not start/close Chrome. Only explicit launch can start the broker or reconnect observation. Connection loss invalidates all captures and response IDs; no automatic retry, reconstruction or reconnection occurs. Ambiguous response failures also invalidate observation. An existing dialog may block observer setup; launch then fails without handling it.

The broker authenticates IPC requests/responses with fresh challenges and a private key. It exposes no general CDP command tool. Multiple adapters have no exclusive browser ownership: independent captures count every observed opening across the managed browser, and shared keyboard/mouse use can interfere. File pickers and browser permission prompts are outside scope.

## Validation

```powershell
npm run check
npm test

# Opens and closes a visible disposable Chrome.
$env:CHROME_DIALOG_INTEGRATION = '1'
node --test test/integration.test.js
```

Unit/stdio tests cover exact event counts, consumed tokens, denied uncaptured IDs, replacement, connection loss, durable IDs, explicit reconnection, process identity and authenticated adapter reuse. Installed-Chrome integration covers accept/dismiss through two stdio adapters and simulated replacement before/after inspection. Its separate CDP driver is test-only.

Earlier manual Computer Use validation passed anticipated confirm accept/dismiss with the previous lookup API: standalone click → MCP response → Computer Use capture. Immediate post-click capture was the isolated turn-ending action. Manual address-bar navigation succeeded where startup navigation and scripted redirects failed. The underlying cause and RDP visibility remain unverified.

Manual capture-flow trials on 2026-10-19 used the existing managed window after the initial capture retry succeeded. Trial 1 observed one opening whose dialog had closed and returned `dialog_not_pending`. Trial 2, with undisclosed human intervention, counted two openings and returned `incorrect_dialog_count` with `observed_count: 2`. Neither released a response ID or sent a broker response; the turn continued. One dialog remained pending for the user to resolve.

A subsequent capture released dialog ID 4 with the expected fixture provenance. After user intervention, a dismissal attempt using ID 4 returned `stale_dialog`; one replacement dialog remained pending. The broker did not act on that replacement.

Dialog ID 6 was captured immediately and held for user intervention. The subsequent dismissal attempt returned `stale_dialog`, with `no_dialog` remaining, validating refusal after the captured dialog had closed without a pending replacement.

Dialog ID 7 remained valid across the pause for user intervention. Its authorised dismissal returned `responded`, followed by `no_dialog`. Computer Use capture then resumed successfully and showed **Test 7: dismissed (false)**, completing the new capture-and-response flow without a turn stop during the trigger, inspection or response.

After capturing ID 8, an explicitly requested response attempt using guessed ID 9 returned `dialog_not_captured`. One dialog remained pending, confirming a guessed current sequence ID could not bypass capture eligibility.

Run `node scripts/serve-dialog-fixture.js` for the local [confirm fixture](test/fixtures/computer-use.html); it prints its URL. This test fixture server is separate from the server-free startup page.
