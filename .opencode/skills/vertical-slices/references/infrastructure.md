# Slice infrastructure

What a project needs before its first slice. `/setup` writes all of it for a new application. In an existing project that lacks it, senior-dev records the decision under Technical Decisions in design.md and makes it the first task group; the Developer adds it. If the project already has its own established way of mapping endpoints, keep that instead and follow it in every slice.

## Endpoint discovery - `src/Shop/Shared/Infrastructure/`

`IEndpoint.cs`:

```csharp
namespace Shop.Shared.Infrastructure;

/// <summary>
/// The HTTP entry point of a vertical slice. Implementations are discovered and mapped at
/// start-up, so a new slice needs no registration code. Implementations take no constructor
/// dependencies: services are parameters of the handler method.
/// </summary>
public interface IEndpoint
{
    void MapEndpoint(IEndpointRouteBuilder app);
}
```

`EndpointExtensions.cs`:

```csharp
using System.Reflection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Shop.Shared.Infrastructure;

public static class EndpointExtensions
{
    /// <summary>Registers every <see cref="IEndpoint"/> implementation in the assembly.</summary>
    public static IServiceCollection AddEndpoints(this IServiceCollection services, Assembly assembly)
    {
        var endpoints = assembly.DefinedTypes
            .Where(type => type is { IsAbstract: false, IsInterface: false } && type.IsAssignableTo(typeof(IEndpoint)))
            .Select(type => ServiceDescriptor.Transient(typeof(IEndpoint), type));

        services.TryAddEnumerable(endpoints);
        return services;
    }

    /// <summary>Maps the routes of every registered <see cref="IEndpoint"/>.</summary>
    public static WebApplication MapEndpoints(this WebApplication app)
    {
        foreach (var endpoint in app.Services.GetRequiredService<IEnumerable<IEndpoint>>())
        {
            endpoint.MapEndpoint(app);
        }

        return app;
    }
}
```

## Program.cs wiring

Add these lines to the project's existing `Program.cs`, keeping everything it already does:

```csharp
using Shop.Shared.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.Services.AddProblemDetails();
builder.Services.AddEndpoints(typeof(Program).Assembly);

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
app.MapDefaultEndpoints();
app.MapEndpoints();

app.Run();
```

- `AddServiceDefaults` and `MapDefaultEndpoints` come from the Aspire ServiceDefaults project: health checks, telemetry for the dashboard, resilience and service discovery.
- `AddProblemDetails` with `UseExceptionHandler` and `UseStatusCodePages` makes every error response a problem details body, which the acceptance tests rely on.
- .NET 10 makes `Program` public for `WebApplicationFactory` automatically - do not add `public partial class Program { }`.

## Unit tests and internal code

So the unit tests can reach `internal` slice code, add `src/Shop/AssemblyInfo.cs`:

```csharp
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Shop.UnitTests")]
```
