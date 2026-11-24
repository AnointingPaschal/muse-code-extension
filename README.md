# Muse Code Chat (Unofficial)

**Unofficial community project. Not made, endorsed, or supported by Meta. Not affiliated with Meta.**

A VS Code chat panel for **Muse Code** — Meta's terminal coding agent. Install it in VS Code, sign in with your own Muse Code account, and code with Muse inside the editor.

This is **not** the Muse personal assistant at muse.ai, and it does not connect to muse.ai. There is no public Muse personal-assistant API. This extension only drives the `muse` CLI installed on your machine, using your own `muse login`.

**Repo:** https://github.com/AnointingPaschal/muse-code-extension

## Installation — quick start (5 minutes)

**You need:** VS Code 1.98+, the Muse Code CLI 1.0.3+, and your own Muse Code account/plan.

**Step 1 — Install Muse Code and sign in with your own account**

```sh
# macOS / Linux
curl -fsSL https://dev.meta.ai/install.sh | bash

# Windows (PowerShell)
irm https://dev.meta.ai/install.ps1 | iex

# Then sign in — this opens a browser sign-in on your machine
muse login
```

Check it worked:

```sh
muse --version
```

**Step 2 — Install this extension in VS Code**

Option A — from the packaged file in this repo:

```sh
code --install-extension muse-code-chat-0.1.0.vsix
```

Option B — in VS Code: Extensions → `...` → **Install from VSIX…** → pick `muse-code-chat-0.1.0.vsix` → Reload.

Option C — build it yourself from this repo:

```sh
git clone https://github.com/AnointingPaschal/muse-code-extension.git
cd muse-code-extension
npm install
npm run package
code --install-extension muse-code-chat-0.1.0.vsix
```

**Step 3 — Open the chat**

1. Open any project folder in VS Code.
2. Click the **Muse Code** icon in the Activity Bar, or press `Ctrl+Shift+P` / `Cmd+Shift+P` and run `Muse Code: Open Chat`.
3. If the CLI is missing or you are not signed in, the panel shows a setup card — follow it, then run `Muse Code: Sign In`.

If `muse` is installed somewhere unusual, set `museCode.executablePath` in VS Code Settings.

## Usage — how to use it day to day

- **Ask Muse to code:** type a prompt in the sidebar and press Enter. Example: `Add a login form to src/pages/Login.tsx and wire it to the API`.
- **Give it a file:** type `@src/index.ts` in your prompt, or select code in the editor first — the selection is sent as context.
- **Use commands:** `/help` lists local commands, `/new` starts a new chat, `/sessions` lists past sessions. Type `!` for a shell-command hint.
- **Approve before anything changes:** when Muse wants to edit a file or run a command, an approval card appears. Click **Approve** or **Deny**. Nothing is applied silently unless you set `museCode.approvalMode` to `allow-all` — use that with care.
- **Review changes:** click **Diff** next to a changed file to see what changed, then **Open** to open the file.
- **Stop or start over:** use **Stop** to cancel a turn, **New chat** to start fresh, or pick an old session from the session list to resume it.
- **Prefer the terminal?** Run `Muse Code: Open in Terminal` to run `muse` in VS Code's integrated terminal.
- **Share code with Muse:** select code, right-click → `Muse Code: Copy Selection for Muse`, or run `Muse Code: Bundle Project for Muse` to write a `muse-bundle.md` of your project (skipping `node_modules`, `.git`, `dist` and binaries).

## What it does

- Sidebar chat panel with streaming messages and tool-call / activity cards
- Approval prompts (Approve / Deny) before Muse applies file changes or runs commands — nothing is applied silently
- Stop, New chat, session list / resume
- `@file` mentions to attach a file, `/` commands (`/help`, `/new`, `/sessions`), `!command` hint for shell commands (still needs approval)
- Image / file context from your current editor selection
- Diff review: changed files are listed with **Diff** and **Open** actions. Diff compares against content captured when the file was used as `@context`; otherwise it shows the file's git diff
- Commands:
  - `Muse Code: Open Chat`
  - `Muse Code: Open in Terminal` — runs `muse` in the VS Code integrated terminal
  - `Muse Code: Check Setup`
  - `Muse Code: Sign In` — runs `muse login` in a terminal you can see
  - `Muse Code: Copy Selection for Muse`
  - `Muse Code: Bundle Project for Muse` — writes `muse-bundle.md`, skipping `node_modules`, `.git`, `dist`, build output and binary files

## Requirements

- VS Code **1.98.0** or higher
- The Muse Code CLI, **1.0.3** or later
- Your own Muse Code login and plan / billing — that is yours, not this extension's. The extension never stores your credentials.

Install Muse Code:

```sh
# macOS / Linux
curl -fsSL https://dev.meta.ai/install.sh | bash

# Windows (PowerShell)
irm https://dev.meta.ai/install.ps1 | iex
```

Then sign in:

```sh
muse login
```

## Install from .vsix

```sh
code --install-extension muse-code-chat-0.1.0.vsix
```

Or in VS Code: Extensions → `...` → **Install from VSIX…**

## Setup

1. Install the extension and the `muse` CLI (above).
2. Open a project folder.
3. Open the **Muse Code** icon in the Activity Bar, or run `Muse Code: Open Chat`.
4. If the CLI is missing, the panel shows a setup card with install instructions and a **Sign in** button.
5. If `muse` is installed somewhere unusual, set `museCode.executablePath` in Settings.

## Usage

- Type a prompt and press Enter (Shift+Enter for a new line).
- Use `@src/index.ts` to attach a file, `/help` for local commands.
- When Muse wants to edit a file or run a command, an approval card appears — approve or deny it. With `museCode.approvalMode` set to `allow-all`, changes are applied without asking; use that with care.
- Click **Diff** next to a changed file to review it before you accept it.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `museCode.executablePath` | `""` | Path to the `muse` CLI. Empty = search PATH, `~/.local/bin`, `/opt/homebrew/bin`. |
| `museCode.extraArgs` | `[]` | Extra arguments passed to `muse serve`. |
| `museCode.approvalMode` | `on-request` | `on-request`, `prompt-unmatched`, `deny-unmatched`, `allow-all`. |

## How it works

- Primary transport: the extension spawns `muse serve` once per workspace folder and talks the **Muse Session Protocol (MSP)** — newline-delimited JSON-RPC over stdio — for sessions, turns, streaming items, approvals and user-input prompts.
- Fallback transport: if `muse serve` fails, the extension falls back to `muse exec --json` per turn and says so clearly in the panel. Fallback turns have no live session, no streaming approvals and no resume.
- Credentials: the extension **never** reads, stores, or sends `~/.config/muse/auth.json`, API keys, or tokens. Auth belongs to your own `muse login`.

## Limitations

- MSP is experimental and may change between Muse releases. The MSP types in `src/msp/types.ts` are hand-written in this starter because the `muse` CLI was not available in the build sandbox. Regenerate them after installing the CLI:
  ```sh
  muse schema generate-ts --out src/msp
  ```
- No connection to the Muse personal assistant at muse.ai.
- The extension was **not** live-tested against a real Muse Code session in the build sandbox (no `muse` CLI there). It was verified by compiling, by unit tests for the JSON-RPC framing, and by a fake `muse serve` test. Live-test it with `muse login` before relying on it.
- `muse exec` fallback turns cannot be cancelled mid-turn the way MSP turns can; Stop marks the turn stopped and ignores further output.

## Development

```sh
npm install
npm run build        # tsc, outputs to out/
npm test             # compile + node --test test/*.test.mjs (framing + fake muse serve)
npm run watch        # tsc watch
# Press F5 in VS Code with this folder open to launch an Extension Development Host
npm run package      # builds muse-code-chat-0.1.0.vsix with @vscode/vsce
```

## License

MIT — see `LICENSE`.
