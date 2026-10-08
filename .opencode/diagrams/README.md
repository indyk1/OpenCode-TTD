# Diagrams (/diagram and /classes)

Two local web pages that draw the application from its code, with [Mermaid](https://mermaid.js.org) (MIT):

- **/diagram** - the architecture on one page: what the Aspire AppHost runs, each feature area with its slices (HTTP method, route, and how many acceptance and unit tests use it), the shared business rules in `Shared/Domain`, the plumbing in `Shared/Infrastructure`, and the test projects.
- **/classes** - a class diagram of one part of the code at a time: a slice, a feature area, `Shared/Domain`, `Shared/Infrastructure` or a whole project.

Both are drawn from the files every time you open or refresh them, so they are always current and nobody has to maintain them. They never change anything. They need only Node.js; there is nothing to install.

## Open them

| From | Type | Notes |
|---|---|---|
| opencode | `/diagram` or `/classes` | Starts the page in the background and opens your browser (one short model turn). |
| opencode, shell mode | `!node .opencode/diagrams/server.mjs --open --detach` (add `--page classes` for the classes) | Same, with no model turn at all. |
| any terminal, in the project root | `node .opencode/diagrams/server.mjs --open` | Runs in the foreground; Ctrl+C stops it. |

Both pages come from one small server on `http://127.0.0.1:4340` (or the next free port): the architecture at `/`, the classes at `/classes`, with tabs between them. Running either command again reuses a server already serving this project. It stops by itself after 15 minutes without activity (an open tab keeps it alive). Click **Refresh** to redraw after the code changes.

## What they show

**Architecture.** One box per project. The application's box holds a box per feature area, with a node per slice. Arrows show what each slice uses: shared rules and plumbing groups (a sub-folder of `Shared/Infrastructure`, such as `Persistence`). A red dashed arrow marks a slice that uses another slice - not allowed, and the architecture tests fail on it. The AppHost's box shows each resource it adds (`AddPostgres`, `AddDatabase`, `AddParameter`, `AddProject`, a deployment environment …) and how they connect (`WithReference`, `WaitFor`, `WithEnvironment`).

**Classes.** Each type with its stereotype (interface, record, enumeration, static …) and members (`+` public, `~` internal, `#` protected, `-` private; static underlined). Records show their primary-constructor parameters as properties. Types are grouped in their namespaces. Arrows: inherits (`<|--`), implements (`<|..`), holds (`-->`, `*` for a collection) and uses (`..>`, from method signatures and from type names in method bodies). With **Types it uses or is used by** ticked, the types outside the chosen part that it uses, or that use it, are drawn too - dashed and without their members. Tests are never drawn as users of application code.

**Copy Mermaid**, **Download .mmd** and **Download SVG** give you the diagram to paste into a GitHub issue, a pull request or a document; GitHub draws Mermaid in Markdown.

## How the code is read

`model.mjs` finds every `.csproj` (skipping `bin`, `obj`, `node_modules`, `.git`, `.opencode`, `.workflow` and `openspec`), and `csharp.mjs` reads the declarations in each project's `.cs` files without compiling them. That makes it fast and free of the .NET SDK, but it is a reader for diagrams, not a compiler:

- Names are matched the way C# does it - nested types, the namespace and the ones around it, `using` directives and aliases - near enough for a diagram. A name it cannot match to a type in the code (a framework type, such as `DbContext`) is left out.
- Code it cannot follow is skipped, never an error. `#if` blocks are read on both sides.
- Slices, routes and HTTP methods follow the template's conventions, like `.opencode/skills/vertical-slices/scripts/overview.sh`: `Features/<Area>/<Slice>/`, `const string Route` in `*.Contracts.cs` and the first `MapGet`/`MapPost`/… call.
- A test is a method with `[Test]`, `[TestCase]`, `[TestCaseSource]` (or xUnit's and MSTest's equivalents). It counts for the slices whose types it uses - usually the slice's contracts.
- AppHost resources are read from the AppHost's top-level statements.

## Mermaid

Mermaid is a 3.5 MB library, so the page loads it from jsDelivr (`cdn.jsdelivr.net`) rather than from this repository. The address is pinned to one version (11.17.2) with its SHA-384 hash, so the browser refuses any other file, and the page's content security policy allows scripts from jsDelivr and nowhere else. Only the library is downloaded - the diagrams are drawn in your browser and nothing about your code leaves your computer. Without an internet connection (or with jsDelivr blocked) the page shows the diagram's Mermaid text instead, to paste into a Markdown file on GitHub or into mermaid.live.

To move to a newer Mermaid, change the version and the hash in `index.html` and check that the tests still pass. The hash is `sha384-` followed by `openssl dgst -sha384 -binary mermaid.min.js | openssl base64 -A` of the new `dist/mermaid.min.js`.

Without a browser: `node .opencode/diagrams/server.mjs --mermaid architecture > architecture.mmd`, or `--mermaid classes [--scope <id>]` - the error for an unknown scope lists the ones there are, such as `slice:Shop/Orders/CancelOrder`.

## Options

```
node .opencode/diagrams/server.mjs [--page architecture|classes] [--open | --no-open] [--detach] [--port <n>] [--root <dir>] [--idle-minutes <n>]
node .opencode/diagrams/server.mjs --mermaid architecture|classes [--scope <id>] [--root <dir>]
```

## Safety

The server binds to 127.0.0.1 only and only reads files. Like the other local pages, it rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, and accepts its one POST (`/api/shutdown`) only as `application/json` from its own origin; they share that code in `.opencode/lib/local-web.mjs`. Mermaid runs with its `strict` security level, so text from the code cannot add HTML or scripts to the page.

## Tests

```
node --test .opencode/diagrams/test/
```

The browser test runs only when the `playwright` package can be found (for example with `NODE_PATH` pointing at a global install); otherwise it is skipped. It never goes online: with `DIAGRAMS_MERMAID_JS` pointing at Mermaid 11.17.2's `dist/mermaid.min.js` (or the `mermaid` package on `NODE_PATH`) it also checks the drawn diagrams; without it, only the offline fallback.
