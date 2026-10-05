# Platform: Aspire and shared capabilities

Technology choices come from `openspec/decisions/platform.md` - never pick a database, sign-in method or host yourself. Aspire changes quickly: confirm an API with `aspire docs search "<topic>"` before writing AppHost code you are unsure of. The examples use `Shop` as the root namespace.

## The projects

```
src/Shop.AppHost/          what runs, locally and in the cloud: the app and its resources (platform agent)
src/Shop.ServiceDefaults/  health checks, telemetry, resilience, service discovery (platform agent)
src/Shop/                  the application - its Program.cs calls AddServiceDefaults() and MapDefaultEndpoints()
```

`aspire start` runs everything in the background, with a dashboard showing logs and traces; `aspire stop` stops it.

## The AppHost

`src/Shop.AppHost/AppHost.cs` (older templates call it `Program.cs`):

```csharp
var builder = DistributedApplication.CreateBuilder(args);

builder.AddProject<Projects.Shop>("shop")
    .WithExternalHttpEndpoints();

builder.Build().Run();
```

`Projects.Shop` is generated from the project reference; dots in a project name become underscores (`Projects.Acme_Orders`).

## Adding a resource: a PostgreSQL database

One change, three parts, three owners.

**1. AppHost - platform agent.** Package `Aspire.Hosting.PostgreSQL` (`aspire add postgres`):

```csharp
var postgres = builder.AddPostgres("postgres").WithDataVolume();
var database = postgres.AddDatabase("shopdb");

builder.AddProject<Projects.Shop>("shop")
    .WithExternalHttpEndpoints()
    .WithReference(database)
    .WaitFor(database);
```

**2. App wiring - Developer, first task of the first slice.** Package `Aspire.Npgsql.EntityFrameworkCore.PostgreSQL`, in the app's `Program.cs`:

```csharp
builder.AddNpgsqlDbContext<AppDbContext>("shopdb");
```

`AppDbContext` lives in `Shared/Infrastructure/Persistence/`. The connection name must match the AppHost's (`shopdb`).

**3. Acceptance tests - Test Writer.** A real PostgreSQL in a throwaway container, package `Testcontainers.PostgreSql`. Never Aspire's test host: it runs the app in a separate process, so NSubstitute substitutes cannot be injected.

`tests/Shop.AcceptanceTests/Infrastructure/TestDatabase.cs` - declared in the test project's root namespace so it starts once for all tests:

```csharp
using Testcontainers.PostgreSql;

namespace Shop.AcceptanceTests;

[SetUpFixture]
public sealed class TestDatabase
{
    private static readonly PostgreSqlContainer Container =
        new PostgreSqlBuilder().WithImage("postgres:17").Build();

    public static string ConnectionString => Container.GetConnectionString();

    [OneTimeSetUp]
    public Task StartAsync() => Container.StartAsync();

    [OneTimeTearDown]
    public async Task StopAsync() => await Container.DisposeAsync();
}
```

Then in `AppFactory.ConfigureWebHost`: `builder.UseSetting("ConnectionStrings:shopdb", TestDatabase.ConnectionString);`. The design decides how the schema is created for tests and how tests stay independent - unique data per test, or a reset between tests.

Containers need a container runtime: Podman (free) or Docker. With Podman, Testcontainers may need `DOCKER_HOST` pointed at the Podman socket. On a Mac, Podman runs inside a virtual machine that must be started (`podman machine start`), and Testcontainers works with it only when the human's environment sets `DOCKER_HOST` to the Podman socket (so it finds Podman) and `TESTCONTAINERS_RYUK_DISABLED=true` (its clean-up container cannot run there) - see the README, "macOS". These are settings on the human's computer: when containers cannot start, report the error to the human rather than working around it in code.

## Capabilities: where they live and how they are tested

- **Sign-in.** Email and password: ASP.NET Core Identity (Microsoft, free). Microsoft or Google accounts: OpenID Connect (`Microsoft.AspNetCore.Authentication.OpenIdConnect`). Never Duende IdentityServer (licence). Endpoints opt in with `.RequireAuthorization()`. Acceptance tests sign in through a test authentication handler registered in `AppFactory` - real authorisation rules, a fake identity. The change that first builds sign-in also adds a debugger test account that exists only when the app runs in Development, its email and password read from user secrets (never from code); the human copies the same values into `.workflow/debugger.env`.
- **Live updates.** SignalR, built in. The hub lives in `Shared/Infrastructure/Realtime/`; slices push through `IHubContext<THub>`. Acceptance tests connect a real SignalR client (`Microsoft.AspNetCore.SignalR.Client`) to the in-memory server and assert the message it receives. Running more than one copy of the app later needs a backplane - a platform decision.
- **A documented API for other systems.** OpenAPI: `builder.Services.AddOpenApi();` and `app.MapOpenApi();` (package `Microsoft.AspNetCore.OpenApi`). Slices describe themselves through `TypedResults`, `.WithName(...)` and `.WithSummary(...)`.
- **AI assistants (MCP).** The official C# SDK, `ModelContextProtocol.AspNetCore`: `builder.Services.AddMcpServer().WithHttpTransport().WithToolsFromAssembly();` and `app.MapMcp();` - check the current API in the SDK's docs. A tool is a second entry point into a slice: `<Slice>.McpTool.cs` next to `<Slice>.Endpoint.cs`, both calling the same internal slice method. When a slice gets a tool, move its logic out of the HTTP handler into that method.

## Deployment targets (`/deploy`)

The platform agent adds the target for the decided host the first time it deploys. Confirm the names with `aspire docs search`.

- **Azure** - Azure Container Apps: `builder.AddAzureContainerAppEnvironment("env");` (package `Aspire.Hosting.Azure.AppContainers`), then `aspire deploy`. The human signs in first with `az login`.
- **Own server or AWS** - Docker Compose: `builder.AddDockerComposeEnvironment("compose");` (package `Aspire.Hosting.Docker`), then `aspire publish` produces the files a technical person runs on the server. Kubernetes is also supported.
