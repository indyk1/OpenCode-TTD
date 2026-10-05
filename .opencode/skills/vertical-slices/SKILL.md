---
name: vertical-slices
description: How this project builds vertical slices. Worked examples of a slice (contracts, endpoint, slice-local business rule), its acceptance tests and unit tests, the infrastructure to add when a project lacks it, and an overview command that lists the existing slices and the shared business rules with the slices that use them. Load before planning a change, writing acceptance tests or implementing a slice.
---

# Vertical slices

The rules are in AGENTS.md, which is always loaded. This skill holds the worked examples and an overview command. Read only the reference you need.

| You are | Read |
|---|---|
| planning a change (senior-dev) | run the overview first; `references/slice.md` for what a slice looks like |
| writing acceptance tests (test-writer) | `references/acceptance-tests.md` |
| implementing a slice (developer) | `references/slice.md`; `references/infrastructure.md` if the project has no `IEndpoint` yet; `references/platform.md` for resource wiring |
| setting up or changing the platform (platform) | `references/platform.md`, `references/infrastructure.md` |
| checking that slice isolation is enforced | `references/architecture-tests.md` |

All paths below are relative to `.opencode/skills/vertical-slices/`. The examples use `Shop` as the root namespace - use the project's own. Where the project already has an established pattern that differs from an example, follow the project and say so in your report.

## Overview command

Run from the repository root:

```bash
.opencode/skills/vertical-slices/scripts/overview.sh [slices|shared|platform|all] [filter]
```

- `slices` - every existing slice: Area/Slice, HTTP method and route.
- `shared` - the shared business rules: each decision in `openspec/decisions/shared-knowledge.md` (superseded ones marked), then each public type in `src/*/Shared/Domain/` with its summary and the slices that use it.
- `platform` - each platform decision in `openspec/decisions/platform.md` (hosting, data, sign-in, live updates, outside access) and whether it is in place yet.
- `all` (default) - both.
- `filter` - keep only lines containing this text, case-insensitive. For example `overview.sh shared discount`.

The overview is computed from the code and the decision logs every time it runs, so it is always current and nobody has to maintain it. Use it instead of reading `Shared/Domain/` file by file, and before asking the human a shared-knowledge question - the answer may already be recorded.
