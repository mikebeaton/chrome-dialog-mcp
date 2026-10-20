# Chrome Dialog MCP

On Windows only, Codex Computer Use stops the current turn when examining a newly opened native Chrome dialog, giving the following error message, which always stops the turn and requires user intervention:

```
{
  "content": [
    {
      "type": "text",
      "text": "Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows with enough confidence to enforce policy. Stop your work and send a final message noting why Computer Use ended."
    }
  ],
  "isError": true
}
```

This MCP lets agents handle expected dialogs (including OK/Cancel confirmations and prompts for text) securely via a different route, avoiding turn stopping. Unexpected dialogs still cause interruptions.

The Chrome-supplied originating web address, dialog type and message are available for the agent to check and respond to.

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
