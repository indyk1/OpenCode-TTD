# Token usage (/costings)

A small local web page that shows how many tokens each agent used on each feature and bug, with CSV export. It reads `.workflow/usage.db`, which the opencode plugin `.opencode/plugins/usage-recorder.js` fills while you work. It needs only Node.js 22.13+ (for its built-in SQLite); there is nothing to install.

## Open it

| From | Type | Notes |
|---|---|---|
| opencode | `/costings` | Starts the page in the background and opens your browser (one short model turn). |
| opencode, shell mode | `!node .opencode/costings/server.mjs --open --detach` | Same, with no model turn at all. |
| any terminal, in the project root | `node .opencode/costings/server.mjs --open` | Runs in the foreground; Ctrl+C stops it. |

The page listens on `http://127.0.0.1:4330` (or the next free port). Running `/costings` again reuses a page already serving this project. It stops by itself after 15 minutes without activity (an open tab keeps it alive). Click **Refresh** to see replies recorded since you opened it.

## What it shows
- One row per feature or bug, newest activity first, with a bar split by agent and the total. "Other" rows are work outside a change, such as `/setup`.
- Click a row for its breakdown per agent: model, runs, input, output, reasoning, cache read, cache write and total tokens.
- **Runs** is how many sessions an agent had in that change. For a subagent that is how many times it was launched: a test-writer with 2 runs had its tests sent back once.
- **Total** is input + output + reasoning + cache read + cache write. opencode reports input without the cache tokens and output without the reasoning tokens, so nothing is counted twice. Cache reads - the conversation re-read on every turn - are usually the largest part.

## How usage is recorded
- The plugin writes one row per finished model reply, with its agent, model, token counts and opencode's cost estimate.
- A reply belongs to the change its session is working on. `/feature` and `/bug` get their change name when the senior-dev runs `openspec new change`; `/resume <name>` names it straight away. The first planning replies, before the name is known, are added to the change once it is named. Subagents belong to the change of the session that launched them.
- Any other command (`/setup`, `/deploy`, `/config`) starts work outside a change, shown under "Other".
- `scripts/finish-change.sh` marks a change finished (date, feature or bug, summary) after archiving it. A change that never finishes - a bug that turned out to work as agreed - stays "open", with its tokens counted.
- Recording works on opencode 1 and opencode 2. opencode 1 records through the hooks `event`, `command.execute.before` and `tool.execute.after`; opencode 2 (which requires the plugin's default export to have the `{ id, setup }` shape) records from its event stream and tool hook, translated for the same recorder by `.opencode/costings/opencode2.mjs`.
- opencode 2 does not say which slash command you typed, so the plugin recognises a command by matching your message against the templates in `.opencode/commands/*.md`. A message that matches no template is ordinary conversation.
- Recording never blocks the workflow. If the database cannot be written, opencode's log gets a warning and that reply is skipped; if `finish-change.sh` cannot mark the change, it prints a warning and saves the work anyway.

## CSV

| File | One row per | Columns |
|---|---|---|
| `usage-by-agent.csv` | change, agent and model | `change,type,status,finished,agent,model,runs,input,output,reasoning,cache_read,cache_write,total,cost_usd` |
| `usage-replies.csv` | model reply | `completed,change,type,agent,model,session,parent_session,input,output,reasoning,cache_read,cache_write,total,cost_usd` |

Both follow the page's filter. Numbers are raw integers, dates are ISO 8601 (UTC), and the files are UTF-8 with a byte-order mark so Excel opens them correctly. `cost_usd` is opencode's estimate from a public price list: with a Claude subscription login it may be 0, or not what you pay.

Without a browser: `node .opencode/costings/server.mjs --csv summary|replies [--filter all|feature|bug|other] > usage.csv`

## Options

```
node .opencode/costings/server.mjs [--open | --no-open] [--detach] [--port <n>] [--root <dir>] [--idle-minutes <n>]
node .opencode/costings/server.mjs --csv summary|replies [--filter all|feature|bug|other] [--root <dir>]
```

## Where the data lives
`.workflow/usage.db` (SQLite), git-ignored, on the computer that runs opencode - inside WSL on Windows. Each git worktree has its own. Delete it to start counting from zero.

## Safety
The server binds to 127.0.0.1 only and never writes the database: it opens it read-only for each request. Like the config editor, it rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, and accepts its one POST (`/api/shutdown`) only as `application/json` from its own origin. Both pages share that code in `.opencode/lib/local-web.mjs`.

## Tests

```
node --test .opencode/costings/test/
node --test .opencode/lib/test/
```

The browser test runs only when the `playwright` package can be found (for example with `NODE_PATH` pointing at a global install); otherwise it is skipped. The `finish-change.sh` test needs bash (Git Bash on Windows; `COSTINGS_TEST_BASH` overrides) and is skipped without it.
