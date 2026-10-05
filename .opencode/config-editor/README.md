# Config editor

A small local web page for changing each agent's **model** and **effort** (`variant`) in `.opencode/agents/*.md`, picking models from the list opencode itself reports. It needs only Node.js 20+; there is nothing to install.

## Open it

| From | Type | Notes |
|---|---|---|
| opencode | `/config` | Starts the editor in the background and opens your browser. The agent replies with the editor's address (one short model turn). |
| opencode, shell mode | `!node .opencode/config-editor/server.mjs --open --detach` | Same, with no model turn at all. |
| any terminal, in the project root | `node .opencode/config-editor/server.mjs --open` | Runs in the foreground; Ctrl+C stops it. |

The editor listens on `http://127.0.0.1:4317` (or the next free port). Running `/config` again reuses an editor that is already serving this project. It stops by itself after 15 minutes without activity (an open editor tab keeps it alive), or when you click **Stop editor**.

**Saved changes apply after you restart opencode**: opencode reads agents once at startup. Quit opencode and run `opencode --continue` to pick up your session again with the new settings.

## What it changes

Only the `model:` and `variant:` lines in each agent file's frontmatter. Every other byte - descriptions, permissions, prompts, line endings - stays as it was. Choosing *Default (unset)* for effort removes the `variant:` line. A save is all-or-nothing: if any change is invalid, no file is written.

`opencode.json` is shown for reference only and is never written.

## Options

```
node .opencode/config-editor/server.mjs [--open | --no-open] [--detach] [--port <n>] [--root <dir>] [--idle-minutes <n>]
```

- `--open` opens the browser; `--no-open` overrides it.
- `--detach` starts the editor in the background, prints `Config editor running at http://127.0.0.1:<port> …` and exits.
- `--port` defaults to 4317; if it is taken, the next nine ports are tried.
- `--root` defaults to the folder two levels above this file (the project root).
- `--idle-minutes` defaults to 15; `0` keeps the editor running until it is stopped.

## Model list

The list comes from `opencode models` (or `opencode models --refresh` when you click **Refresh model list**). If opencode is not available and `ANTHROPIC_API_KEY` is set, the editor lists models from the Anthropic API instead. If neither works, pick **Custom…** and type the model as `provider/model`.

## Safety

The server binds to 127.0.0.1 only, rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), and accepts writes only as `application/json` from its own origin (cross-site requests). It can only edit agent files that already exist.

## macOS, Windows and WSL

Run it where you run opencode. On macOS the browser is opened with `open`. Under WSL it is opened on the Windows side (`wslview`, then `cmd.exe /c start`, then `explorer.exe`). If nothing opens, copy the printed address into your browser.

## Tests

```
node --test .opencode/config-editor/test/
```

The browser test runs only when the `playwright` package can be found (for example with `NODE_PATH` pointing at a global install); otherwise it is skipped.
