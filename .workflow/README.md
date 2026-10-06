# .workflow

- `acceptance.lock` - a SHA-256 hash of every acceptance test file and every slice contract (`*.Contracts.cs`), written by `scripts/lock-tests.sh` when you approve the tests at checkpoint 2. `scripts/check-test-lock.sh` compares the working tree with it; `--list` shows what changed since the last lock. Commit it.
- `debugger.env` - the debugger's local test account (see GUIDE.md). Ignored by git. The browser tool reads it to mask the values; the debugger itself must ask you before reading it.
- `usage.db` - the token usage behind `/costings`: one row per model reply, written by the opencode plugin in `.opencode/plugins/`, and each change marked finished by `scripts/finish-change.sh`. Ignored by git (with its `-wal` and `-shm` files), so it stays on this computer. Delete it to start counting from zero.

No agent can edit this folder, and every agent run of `scripts/lock-tests.sh` asks for your permission.
