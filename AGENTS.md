# Project rules

This repository is built with a gated, test-first workflow (see `.opencode/docs/workflow.md`). These rules apply to every agent and every human.

## Stack
- .NET 10 and ASP.NET Core minimal APIs, run and deployed with .NET Aspire
- NUnit with the constraint model (`Assert.That`), and NSubstitute
- OpenSpec for specs and change planning (`openspec/`)

## Platform
- Every technology choice - hosting, database, sign-in, live updates, APIs for other systems, AI-assistant access, email, storage - follows `openspec/decisions/platform.md`. Anything not decided there is asked about in plain English before it is built.
- `src/<App>.AppHost` (what runs: the app and its resources) and `src/<App>.ServiceDefaults` (health, telemetry, resilience) belong to the platform agent. Application code never references the AppHost.
- `aspire start` runs the app and its resources in the background; `aspire stop` stops it.
- Local development secrets (API keys, passwords, connection strings for outside services) live in user secrets, never in `appsettings*.json`, `local.settings.json` or any committed file. In Aspire a secret is an AppHost parameter (`AddParameter(..., secret: true)`) whose value the human sets with `dotnet user-secrets` - agents never see or type secret values. The skill's `references/platform.md` shows the pattern.

## Architecture: vertical slices only
- One slice = one use case at the API boundary (one command or query) = one OpenSpec requirement.
- A slice lives in `src/<App>/Features/<Area>/<Slice>/` with namespace `<App>.Features.<Area>.<Slice>`. Keep slice folders flat - no sub-namespaces.
- `<Slice>.Contracts.cs` holds the slice's public shape: a `public static class <Slice>Contracts` with the `Route` constant, a `Path(...)` method when the route has parameters, and nested `sealed record` request and response types. The Test Writer creates it from design.md; it is locked together with the acceptance tests.
- `<Slice>.Endpoint.cs` holds a `sealed class <Slice>Endpoint : IEndpoint`, which is discovered automatically. Endpoints have no constructor dependencies; services are parameters of the handler method. Return `TypedResults`; errors are problem details.
- Slices never reference other slices. The architecture tests fail the build if one does.
- Default: business logic lives inside its slice. Duplication is cheaper than the wrong abstraction.
- `src/<App>/Shared/Infrastructure/` is technical plumbing (endpoint discovery, persistence, auth, real-time hubs, time).
- `src/<App>/Shared/Domain/` is business rules several slices must apply identically. Code goes there only through a human decision recorded in `openspec/decisions/shared-knowledge.md`. It must not depend on Infrastructure or ASP.NET Core.
- Shared code never depends on Features.
- No mediator or mapping libraries: endpoints call the slice's own code, and mapping is written by hand.
- Worked examples - a slice, its tests, the infrastructure and platform patterns - are in the `vertical-slices` skill. Load it rather than guessing.

## Tests
- **Acceptance tests** (`tests/<App>.AcceptanceTests`): exactly one per OpenSpec scenario, written from the test plan before implementation, reviewed by the test-reviewer, approved by the human and then locked (`scripts/lock-tests.sh`). They host the real application in-process with `WebApplicationFactory` (the `AcceptanceTest` base class) and substitute only out-of-process dependencies (email, payments, external APIs).
- Real dependencies such as a database run in throwaway containers for the tests (Testcontainers), as the skill's `references/platform.md` shows. Never use Aspire's test host for acceptance tests: it runs the app in another process, so substitutes cannot be injected.
- Each acceptance test has the scenario text as a comment above it and `[Property("Scenario", "<capability-path>: <scenario name>")]`. `scripts/check-scenarios.sh` checks the 1:1 mapping.
- Assert the status code first, then read and assert the body.
- **Unit tests** (`tests/<App>.UnitTests`): the Developer's own red-green-refactor for non-trivial logic inside a slice or in Shared/Domain.
- **Architecture tests** (`tests/<App>.ArchitectureTests`): owned by the human (created by `/setup`). Agents never edit them afterwards.
- Never skip, ignore, weaken or delete a test to get to green.

## Packages
- Free, OSI-approved permissive licences only (MIT, Apache-2.0, BSD). Nothing that needs a licence key, a paid tier, or a "community licence" with revenue or team-size limits.
- Do not use MediatR, AutoMapper, FluentAssertions, MassTransit or Duende IdentityServer - they need commercial licences - or anything with similar terms.
- Prefer what .NET and Aspire already ship. Every new package needs the human's approval: agents cannot add one without a permission prompt.

## Commands
- `dotnet build`, `dotnet test`
- `aspire start` / `aspire stop` - run the app with its resources and dashboard
- `scripts/verify.sh <change>` - build, all tests, lock check, scenario coverage
- `scripts/check-test-lock.sh` - are the locked tests untouched? (`--list` shows what changed since the last lock)
- `scripts/check-scenarios.sh <change> --plan|--tests` - one test-plan entry / one test per scenario
- `.opencode/skills/vertical-slices/scripts/overview.sh [slices|shared|platform]` - existing slices, shared business rules, platform decisions

## Boundaries
- Each agent can edit only its own areas (see `.opencode/agents/`). A denied edit is a boundary: never make the same change through bash or another route - report it.
- The debugger and test-reviewer never change code.
- Only `scripts/finish-change.sh` saves work in git, and it asks the human first. Agents never push, and never change `.workflow/`, `scripts/`, `opencode.json`, `.opencode/`, `AGENTS.md` or `openspec/schemas/`.
