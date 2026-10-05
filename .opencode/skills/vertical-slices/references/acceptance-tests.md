# Acceptance tests

One test per OpenSpec scenario, driving the real application over HTTP. The Test Writer writes them from the test plan; the human approves them; then they are locked.

## Infrastructure - create these if the project does not have them yet

Both go in `tests/Shop.AcceptanceTests/Infrastructure/`. The acceptance test project itself (NUnit, `Microsoft.AspNetCore.Mvc.Testing`, `NSubstitute`, a reference to the app) must already exist - if it doesn't, stop and report it.

`AppFactory.cs`:

```csharp
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Shop.AcceptanceTests.Infrastructure;

/// <summary>Hosts the real application in memory for one test.</summary>
public sealed class AppFactory(Action<IServiceCollection> configureServices) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureTestServices(configureServices);
    }
}
```

`AcceptanceTest.cs`:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using NSubstitute;

namespace Shop.AcceptanceTests.Infrastructure;

/// <summary>
/// Base class for acceptance tests. Every test gets a fresh in-memory application,
/// so tests never share state.
/// </summary>
public abstract class AcceptanceTest
{
    private AppFactory? _factory;
    private HttpClient? _client;

    protected HttpClient Client =>
        _client ?? throw new InvalidOperationException("The client is created in SetUp.");

    [SetUp]
    public void StartApplication()
    {
        _factory = new AppFactory(ConfigureServices);
        _client = _factory.CreateClient();
    }

    [TearDown]
    public async Task StopApplication()
    {
        _client?.Dispose();
        if (_factory is not null)
        {
            await _factory.DisposeAsync();
        }
    }

    /// <summary>
    /// Override to replace out-of-process dependencies (email, payments, external APIs)
    /// with substitutes. Never substitute the application's own code.
    /// </summary>
    protected virtual void ConfigureServices(IServiceCollection services)
    {
    }

    /// <summary>Replaces every registration of <typeparamref name="T"/> with a substitute.</summary>
    protected static T ReplaceWithSubstitute<T>(IServiceCollection services)
        where T : class
    {
        var substitute = Substitute.For<T>();
        services.RemoveAll<T>();
        services.AddSingleton(substitute);
        return substitute;
    }
}
```

`WebApplicationFactory<Program>` needs a public `Program`; .NET 10 generates it, so there is nothing to add.

If the application uses a database, `AppFactory` points it at a disposable test database (for example Testcontainers for .NET, or SQLite in memory for EF Core). That is a technical decision recorded in design.md; never substitute the database or the `DbContext`.

## A test class

Tests for the `Orders/CancelOrder` slice from `slice.md`, in `tests/Shop.AcceptanceTests/Features/Orders/CancelOrderTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using Shop.AcceptanceTests.Infrastructure;
using Shop.Features.Orders.CancelOrder;
using Shop.Features.Orders.PlaceOrder;
using Shop.Shared.Infrastructure.Email;

namespace Shop.AcceptanceTests.Features.Orders;

public sealed class CancelOrderTests : AcceptanceTest
{
    private IEmailSender _email = null!;

    // Email leaves the process, so it is substituted. Everything else runs for real.
    protected override void ConfigureServices(IServiceCollection services) =>
        _email = ReplaceWithSubstitute<IEmailSender>(services);

    // Scenario: Cancels an unshipped order  [ordering]
    //   GIVEN a placed order that has not shipped
    //   WHEN the customer cancels it
    //   THEN the response status is 200 OK
    //   AND the order status is Cancelled
    //   AND the customer is emailed a cancellation notice
    [Test]
    [Property("Scenario", "ordering: Cancels an unshipped order")]
    public async Task Cancels_an_unshipped_order()
    {
        // Given
        var placed = await Client.PostAsJsonAsync(
            PlaceOrderContracts.Route,
            new PlaceOrderContracts.Request("SKU-001", 2, "ada@example.com"));
        Assert.That(placed.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        var order = (await placed.Content.ReadFromJsonAsync<PlaceOrderContracts.Response>())!;

        // When
        var response = await Client.PostAsync(CancelOrderContracts.Path(order.OrderId), content: null);

        // Then
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var body = await response.Content.ReadFromJsonAsync<CancelOrderContracts.Response>();
        Assert.Multiple(() =>
        {
            Assert.That(body?.OrderId, Is.EqualTo(order.OrderId));
            Assert.That(body?.Status, Is.EqualTo("Cancelled"));
        });
        await _email.Received(1).SendAsync(
            Arg.Is<EmailMessage>(m => m.To == "ada@example.com" && m.Subject == "Your order was cancelled"),
            Arg.Any<CancellationToken>());
    }

    // Scenario: Rejects cancelling an unknown order  [ordering]
    //   GIVEN no order with the requested id exists
    //   WHEN the customer cancels it
    //   THEN the response status is 404 Not Found
    //   AND the problem title is "Order not found"
    //   AND no email is sent
    [Test]
    [Property("Scenario", "ordering: Rejects cancelling an unknown order")]
    public async Task Rejects_cancelling_an_unknown_order()
    {
        // Given
        var unknownOrderId = Guid.Parse("00000000-0000-0000-0000-000000000001");

        // When
        var response = await Client.PostAsync(CancelOrderContracts.Path(unknownOrderId), content: null);

        // Then
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        // A missing endpoint also answers 404, so the title proves the slice handled the request.
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        Assert.That(problem?.Title, Is.EqualTo("Order not found"));
        await _email.DidNotReceive().SendAsync(Arg.Any<EmailMessage>(), Arg.Any<CancellationToken>());
    }
}
```

## Checklist for every test
- The scenario text is copied verbatim into the comment; the `Property` value is exactly `<capability-path>: <scenario name>`.
- The Given builds state through existing endpoints where it can, with literal values.
- The status code is asserted first, on its own, before the body is read - otherwise a red test fails on JSON deserialisation instead of on the assertion.
- The remaining body assertions sit in `Assert.Multiple`; substitute checks come after it, awaited.
- If the expected status is one a missing endpoint could also produce (404, 405), assert something in the body that only the real slice returns.
- No branching or loops except to build data; no `[Ignore]`, `Assert.Pass`, `Assert.Inconclusive`, `Assert.Warn`, try/catch, `Thread.Sleep` or `Task.Delay`.
