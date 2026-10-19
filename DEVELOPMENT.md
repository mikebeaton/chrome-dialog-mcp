# Development and validation

This document retains the runtime setup, tool contract and validation record. User installation is covered by [README.md](README.md); package builds and CI are covered by [RELEASES.md](RELEASES.md).

A Windows stdio MCP server for capturing Chrome JavaScript dialog provenance and responding to an identified dialog. Normal browser interaction stays with Computer Use; the agent checks origin and user authorisation.

Only **anticipated dialogs** are supported. The agent arms a capture before the known operation. A response ID is released only when exactly one opening was observed and that dialog remains pending.

## Package installation

The [README installation guide](README.md#install) covers the `.tgz`, choosing a persistent directory and registering the installed adapter in Codex. Requires Windows, Chrome and Node.js 24+. The package includes a dependency shrinkwrap; npm installs the locked runtime dependencies.

Each package version automatically uses its own state directory and broker. Upgrades start fresh sessions; older windows remain with their original broker. Restart Codex after updating its adapter path to refresh tool schemas and guidance. Protocol v4 also refuses rc.1–rc.4 brokers that lack session isolation.

## Workflow

1. `launch_chrome()` creates a new Chrome process/profile and establishes observation. Keep its returned `browser_token` private and supply it on every subsequent call. Only `launch_chrome(browser_token)` explicitly reuses/reconnects that same session; it never creates a replacement process. New instances display the bundled [startup page](assets/start.html) as a local file; no page server is needed.
2. After a fresh launch reports `ready`, use the returned Windows identifiers to select and inspect that exact window directly through Computer Use, without checking for pending dialogs first. If Computer Use refuses access for insufficient site evidence or an undetermined browser URL, ask the user to choose a valid website themselves, manually type its address into that window, wait for it to load and confirm when done. Do not supply or suggest an address. Retry the connection after confirmation.
3. Observe the page, then call `start_dialog_capture(browser_token)` immediately before the anticipated operation.
4. Perform the operation without automatic post-action Computer Use capture. Call `get_captured_dialog(browser_token, capture_id)` once to seal the interval.
5. On success, verify URL, type and message against the operation and user instructions. Respond with that `browser_token` and `dialog_id`, confirm `get_dialog_status(browser_token)` returns `no_dialog`, then resume Computer Use.

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

For packaged installations, prerelease trials and GitHub CI, see [Releases](RELEASES.md).

| Environment variable | Purpose |
| --- | --- |
| `CHROME_DIALOG_CHROME_PATH` | Optional Chrome executable path. |
| `CHROME_DIALOG_START_URL` | Optional HTTP(S) startup override; default is the bundled `assets/start.html` file. |
| `CHROME_DIALOG_STATE_DIR` | Optional private state base folder; default `%LOCALAPPDATA%/ChromeDialogMcp`. The installed package version is always appended, including for custom locations. |

The persistent broker inherits settings when first started. Its version-specific state directory contains the IPC authentication key, dialog sequence and a `sessions/` directory with separate Chrome profiles and session metadata; use a base folder private to your Windows account. Session directory names are hashes of the private tokens. Adapters using the same base folder and package version share a broker, with separate browser sessions by default. For example, version `0.2.0-rc.9` uses `%LOCALAPPDATA%/ChromeDialogMcp/0.2.0-rc.9`; an explicit base folder gets the same version suffix. Older unversioned state is left untouched. Browser tokens belong to their original version's broker and do not transfer across upgrades. Reinstalling the same version uses its existing state.

## Tools

| Tool | Result |
| --- | --- |
| `launch_chrome(browser_token?)` | Omit the token for a new session; supply it for explicit reuse. Returns `ready`, `browser_token`, PID, HWND and Windows session ID; unavailable Windows identifiers are `null`. Failed initial launches also return a token for cleanup. |
| `get_dialog_status(browser_token)` | `no_dialog`, `dialog_pending` with pending count, or `not_connected`. Returns no response ID or provenance. |
| `start_dialog_capture(browser_token)` | Arms observation in that session and returns a single-use `capture_id`; refuses an already-pending dialog there. |
| `get_captured_dialog(browser_token, capture_id)` | Seals the interval. Exactly one still-pending opening in that session returns `captured`, `dialog_id`, browser-reported URL, type, message and accept/dismiss options. |
| `respond_to_dialog(browser_token, dialog_id, action, prompt_text?)` | Accepts/dismisses only a successfully captured, still-current dialog in that session, once. Prompt acceptance requires explicit text, including an intentional empty string. |
| `close_chrome(browser_token)` | Explicitly closes only that session, using graceful CDP shutdown or verified process-tree termination. Success revokes its token. An absent service returns `not_connected`, not proof that Chrome has exited. |

Browser tokens, capture tokens and dialog IDs are distinct. Missing, malformed, unknown or revoked browser tokens are refused; passing another session's capture token or dialog ID does not consume or operate the original. Frame IDs, CDP endpoints, profile paths and CDP target/session IDs are omitted. Windows identifiers select the managed window; they do not prove RDP visibility.

Adapter startup/exit does not start/close Chrome. Only explicit launch can start the broker or reconnect observation. Connection loss invalidates all captures and response IDs; no automatic retry, reconstruction or reconnection occurs. Ambiguous response failures also invalidate observation. An existing dialog may block observer setup; launch then fails without handling it.

Each agent normally launches and retains its own browser session. This prevents implicit reuse when switching between agents, including sequential use. Browser tokens survive adapter exit and service restart, within the same broker state directory. Restart requires explicit `launch_chrome(browser_token)` to establish new observation; old captures/permissions never survive. Closed session tokens remain revoked after restart. Tokens grant access through possession, not verified agent identity; deliberate handover requires explicitly sharing a token. There is no session enumeration or lost-token recovery tool. Profiles and revocation metadata remain on disk after close.

The broker authenticates IPC requests/responses with fresh challenges and a private key. It exposes no general CDP command tool. Captures count every observed opening across all tabs/windows in their Chrome instance, excluding separate managed sessions. Agents deliberately sharing a token can interfere. Dialog responses go directly to the token-selected Chrome instance over CDP and do not depend on desktop focus. Desktop input coordination remains with Computer Use. File pickers and browser permission prompts are outside scope.

## Validation

```powershell
npm run check
npm test

# Opens and closes two visible disposable Chrome processes.
$env:CHROME_DIALOG_INTEGRATION = '1'
node --test test/integration.test.js
```

Unit/stdio tests cover isolated sessions, token validation/revocation/restart, exact event counts, consumed tokens, denied uncaptured IDs, replacement, connection loss, durable IDs, explicit reconnection, process identity and authenticated adapter reuse. Installed-Chrome integration covers two separate processes/profiles, independent concurrent capture counts, refused cross-session IDs, scoped close, prompt responses and simulated replacement through two stdio adapters. Its separate CDP driver is test-only.

Earlier manual Computer Use validation passed anticipated confirm accept/dismiss with the previous lookup API: standalone click → MCP response → Computer Use capture. Immediate post-click capture was the isolated turn-ending action.

Direct Computer Use connection to the local startup page passed, followed by a captured confirm acceptance and resumed Computer Use. User testing with fresh agents on rc.8 also passed without manual navigation. Earlier URL-evidence refusals were resolved by manual address-bar navigation; this is now a fallback, not a required startup step. The underlying cause of those refusals and RDP visibility remain unverified.

The separate `coordinate input geometry is unavailable` error was resolved by confirming `no_dialog`, capturing the same window with screenshot and text, then retrying the refused click with its existing capture ID. This recovery applies only after that error; it adds no preventive screenshots.

Manual capture-flow trials on 2026-10-19 used the existing managed window after the initial capture retry succeeded. Trial 1 observed one opening whose dialog had closed and returned `dialog_not_pending`. Trial 2, with undisclosed human intervention, counted two openings and returned `incorrect_dialog_count` with `observed_count: 2`. Neither released a response ID or sent a broker response; the turn continued. One dialog remained pending for the user to resolve.

A subsequent capture released dialog ID 4 with the expected fixture provenance. After user intervention, a dismissal attempt using ID 4 returned `stale_dialog`; one replacement dialog remained pending. The broker did not act on that replacement.

Dialog ID 6 was captured immediately and held for user intervention. The subsequent dismissal attempt returned `stale_dialog`, with `no_dialog` remaining, validating refusal after the captured dialog had closed without a pending replacement.

Dialog ID 7 remained valid across the pause for user intervention. Its authorised dismissal returned `responded`, followed by `no_dialog`. Computer Use capture then resumed successfully and showed **Test 7: dismissed (false)**, completing the new capture-and-response flow without a turn stop during the trigger, inspection or response.

After capturing ID 8, an explicitly requested response attempt using guessed ID 9 returned `dialog_not_captured`. One dialog remained pending, confirming a guessed current sequence ID could not bypass capture eligibility.

Run `node scripts/serve-dialog-fixture.js` for the local [confirm fixture](test/fixtures/computer-use.html); it prints its URL. This test fixture server is separate from the server-free startup page.
