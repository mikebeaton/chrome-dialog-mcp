# Chrome Dialog MCP

Chrome's native dialogs interrupt Computer Use. Chrome Dialog MCP lets Codex check where a dialog came from and respond according to your instructions.

Using it, agents working via Computer Use can handle expected JavaScript dialogs without any user intervention. This includes OK/Cancel confirmations and prompts for text. The Chrome-supplied originating web address, dialog type and message are available for the agent to check and respond to.

Computer Use stops if it examines the screen while a native dialog is open. This MCP lets the agent handle expected dialogs before that happens, but unexpected dialogs still cause interruptions.

## Security

Using this MCP moves the decision to handle a native dialog from Computer Use to Codex. You are trusting Codex to check the source and choose a response that follows your instructions.

Before the expected action, the agent starts a capture using this MCP to record any dialogs that open. The MCP checks that:

- Exactly one dialog opened during the capture.
- That same dialog is still open.
- Permission to respond applies to that same dialog and is used once.

Each browser session has its own dialog records and response permissions.

## Requirements

Windows, Google Chrome, Codex desktop, and Node.js 24 or later with npm.

Check your Node version with `node --version` in PowerShell.

## Install

Download `chrome-dialog-mcp-1.0.0.tgz` from [GitHub Releases](https://github.com/mikebeaton/chrome-dialog-mcp/releases). The download can stay in any convenient folder; the install command chooses where the program will live.

Open PowerShell in the folder containing the download and run:

```powershell
npm install --prefix C:/Tools/chrome-dialog-mcp/1.0.0 --ignore-scripts --omit=dev ./chrome-dialog-mcp-1.0.0.tgz
```

npm extracts the package and installs the libraries it needs. The `--prefix` option selects the installation folder: `C:\Tools\chrome-dialog-mcp\1.0.0` in this example. Keep that folder while the MCP is configured.

For an installation under your own Windows account, use a path such as `C:/Users/YOUR_NAME/Tools/chrome-dialog-mcp/1.0.0` after `--prefix`. Replace `YOUR_NAME` with your Windows user-folder name.

## Configure Codex

In Codex, open **Settings → Configuration**. Select **Open config.toml**, the small grey link beside **User config**.

Add the following settings to the file. If a `chrome_dialog` entry already exists, update it:

```toml
[mcp_servers.chrome_dialog]
command = "node"
args = ["C:/Tools/chrome-dialog-mcp/1.0.0/node_modules/chrome-dialog-mcp/src/adapter.js"]
tool_timeout_sec = 60
```

Adjust the path in `args` if you chose another installation folder.


Save the file and restart Codex. Codex starts the MCP automatically.

## Start a browser

Start a new local chat and ask:

> Use chrome_dialog to launch a managed Chrome window.

Codex opens a window labelled **Chrome Dialog MCP** and connects to it.

Each agent launches a separate Chrome process and profile, keeping its browser state separate when you switch between chats.

Chrome stays open between tasks. You can ask Codex to close its MCP managed browser when you have finished.

[Technical details](chrome-dialog-mcp-spec.md) · [Development](DEVELOPMENT.md) · [Releases](RELEASES.md) · [0BSD license](LICENSE)
