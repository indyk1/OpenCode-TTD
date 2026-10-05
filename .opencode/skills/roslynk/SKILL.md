---
name: roslynk
description: How to use the Roslynk tools (roslynk_*) - a live Roslyn compilation of this solution - to find C# code and check that it compiles, faster and more accurately than grep, whole-file reads or dotnet build. Load before reading, tracing or changing C# code when the roslynk_* tools are available.
---

# Roslynk

Roslynk holds a live Roslyn compilation of the solution. It answers "where is this defined?", "who calls it?", "what uses it?" and "does it compile?" from the compiler's own model, so it sees partial classes, generated code and `#if` branches, and never matches a name inside a comment or a string. Grep does none of that.

In this workflow Roslynk is **read-only**: you get its navigation and diagnostics tools, never its editing tools. Each tool's exact parameters and output are in its own description; this skill covers when to use which. Upstream's fuller guide is written for Claude Code, whose tool names differ: https://github.com/mrpmorris/Roslynk/tree/07b64a6eaaf1b3af946ba1b3b8d92c1978168b96/skills/roslynk

## Open the solution first
1. Find the solution file in the repository root (`ls *.slnx *.sln`). No solution yet means no Roslynk - use your other tools.
2. Call `roslynk_open_solution` with its **absolute** path: the working directory from your environment plus the file name. Keep the `solutionId` it returns; every other tool needs it. It is the solution's full path - copy all of it, spaces included.
3. It loads in the background. While it does, tools return `error=Indexing`: wait a second and retry, or poll `roslynk_get_solution_status`. Loading takes from a few seconds to a minute.

## Which tool
| You want to... | Use |
|---|---|
| know whether it compiles, and why not | `roslynk_get_diagnostics` |
| jump from a usage to its declaration | `roslynk_find_definition` (file, line, column) |
| see every usage of a type or member | `roslynk_find_references` |
| see who calls a method | `roslynk_get_callers` |
| see where a field, property or parameter is read or written | `roslynk_find_reads`, `roslynk_find_writes` |
| find implementations or derived types | `roslynk_find_implementations`, `roslynk_get_type_hierarchy` |
| read one member without reading the whole file | `roslynk_get_symbol_body` |
| list a type's members | `roslynk_get_members` |
| find a symbol by part of its name | `roslynk_search_symbols` |
| know what an expression is (the type behind `var`, the overload chosen, nullability) | `roslynk_get_expression_info` |
| ask several of these at once | `roslynk_multi_query` |

Before changing a type or member, ask what depends on it in one `roslynk_multi_query`: `get_symbol`, `find_references`, `get_callers`, `find_implementations` and `get_type_hierarchy`, each pointed at it. The answers come from one snapshot, so they agree with each other.

Names are fully qualified (`Namespace.Type.Member`, with a parameter list such as `(int)` to pick an overload). On `error=Ambiguous` or `error=NotFound`, copy one of the `candidate=` lines back verbatim. On `truncated=Y`, raise `maxResults`. Query again after any edit rather than reusing an earlier answer.

## Compile checks
`roslynk_get_diagnostics` replaces waiting for `dotnet build` while you work. A bare call returns counts (`errors=`, `warnings=`); when they are not zero, call it again with `includeErrors=true` (or `includeWarnings=true`) for the details. `roslynk_get_code_actions` lists the fixes Roslyn offers at a position - treat them as suggestions.

It does not run tests. `dotnet test` is still the proof: run it before you report, and report its results.

## Editing
Roslynk's editing tools are not available to you. Make every change with your normal edit tool; Roslynk's file watcher picks it up, so your next query sees it. Apply a suggested code action by hand.

A denied tool is a boundary, exactly like a denied edit (AGENTS.md): never try to reach the same result another way.

## Reload
Call `roslynk_reload_solution` only when answers are clearly out of date even after querying again - for example after a package restore or a branch switch. The file watcher handles ordinary edits.

## If Roslynk is unavailable
If the `roslynk_*` tools are missing, fail to start, or keep returning errors other than `Indexing`, carry on with your other tools (file reads, grep, `dotnet build`) and say in your report that Roslynk was unavailable. Never stop work because of it.
