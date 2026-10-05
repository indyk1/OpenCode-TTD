---
description: Resume an in-flight change from its status file
agent: senior-dev
---
Resume the change "$ARGUMENTS": read openspec/changes/$ARGUMENTS/status.md and the output of `openspec status --change "$ARGUMENTS" --json`, tell me in two sentences where we are, then continue from the recorded phase.

If no change name was given, run `openspec list --json`, then ask me which change to resume.
