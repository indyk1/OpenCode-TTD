# A slice: Orders/CancelOrder

One use case at the API boundary: "a customer cancels an order that has not shipped". Everything it needs lives in one flat folder:

```
src/Shop/Features/Orders/CancelOrder/
  CancelOrder.Contracts.cs   public shape - written by the Test Writer, locked with the tests
  CancelOrder.Endpoint.cs    route + handler - written by the Developer
  CancellationPolicy.cs      a business rule only this slice uses - stays in the slice
```

The example assumes the project's persistence (`AppDbContext` with an `Order` entity) and an email abstraction (`IEmailSender`) in `Shared/Infrastructure/`. Use whatever the project actually has.

## CancelOrder.Contracts.cs

```csharp
namespace Shop.Features.Orders.CancelOrder;

public static class CancelOrderContracts
{
    public const string Route = "/orders/{orderId:guid}/cancel";

    // Routes with parameters get a Path method, so tests never build URLs by hand.
    public static string Path(Guid orderId) => $"/orders/{orderId}/cancel";

    public sealed record Response(Guid OrderId, string Status);
}
```

Contracts hold only the route, an optional `Path` helper and records - no other logic. This slice has no request body; a slice that does adds `public sealed record Request(...)`.

## CancelOrder.Endpoint.cs

```csharp
using Microsoft.AspNetCore.Http.HttpResults;
using Shop.Shared.Infrastructure;
using Shop.Shared.Infrastructure.Email;
using Shop.Shared.Infrastructure.Persistence;

namespace Shop.Features.Orders.CancelOrder;

public sealed class CancelOrderEndpoint : IEndpoint
{
    public void MapEndpoint(IEndpointRouteBuilder app) =>
        app.MapPost(CancelOrderContracts.Route, Handle);

    // Dependencies are handler parameters, never constructor arguments.
    internal static async Task<Results<Ok<CancelOrderContracts.Response>, ProblemHttpResult>> Handle(
        Guid orderId,
        AppDbContext db,
        IEmailSender email,
        CancellationToken cancellationToken)
    {
        var order = await db.Orders.FindAsync([orderId], cancellationToken);
        if (order is null)
        {
            return TypedResults.Problem(
                title: "Order not found",
                detail: $"There is no order {orderId}.",
                statusCode: StatusCodes.Status404NotFound);
        }

        if (!CancellationPolicy.CanCancel(order.Status))
        {
            return TypedResults.Problem(
                title: "Order cannot be cancelled",
                detail: $"Order {orderId} is {order.Status}.",
                statusCode: StatusCodes.Status409Conflict);
        }

        order.Status = OrderStatus.Cancelled;
        await db.SaveChangesAsync(cancellationToken);

        await email.SendAsync(
            new EmailMessage(order.CustomerEmail, "Your order was cancelled", $"Order {order.Id} has been cancelled."),
            cancellationToken);

        return TypedResults.Ok(new CancelOrderContracts.Response(order.Id, order.Status.ToString()));
    }
}
```

- The handler reads top to bottom: load, check, change, save, side effects, respond. No mediator, no mapping library, no repository per slice.
- Errors are problem details with a specific title, which the acceptance tests can assert on.
- Entities are shared data. Changing their shape is a technical decision; a business rule about them (a method that decides something) belongs in a slice - or in `Shared/Domain/` by the human's decision.

## CancellationPolicy.cs

```csharp
using Shop.Shared.Infrastructure.Persistence;

namespace Shop.Features.Orders.CancelOrder;

internal static class CancellationPolicy
{
    public static bool CanCancel(OrderStatus status) =>
        status is OrderStatus.Placed or OrderStatus.Paid;
}
```

A rule only this slice uses stays here, even if another slice has a similar-looking one. Moving it to `Shared/Domain/` is the human's decision: both places must change together, for the same business reason.

## The unit test (Developer's inner loop)

`tests/Shop.UnitTests/Features/Orders/CancelOrder/CancellationPolicyTests.cs`:

```csharp
using Shop.Features.Orders.CancelOrder;
using Shop.Shared.Infrastructure.Persistence;

namespace Shop.UnitTests.Features.Orders.CancelOrder;

public sealed class CancellationPolicyTests
{
    [TestCase(OrderStatus.Placed, true)]
    [TestCase(OrderStatus.Paid, true)]
    [TestCase(OrderStatus.Shipped, false)]
    [TestCase(OrderStatus.Cancelled, false)]
    public void Only_orders_that_have_not_shipped_can_be_cancelled(OrderStatus status, bool expected) =>
        Assert.That(CancellationPolicy.CanCancel(status), Is.EqualTo(expected));
}
```

Unit-test rules, calculations and branching. Thin glue (mapping a route, saving) is covered by the acceptance tests. Testing `internal` code needs `[assembly: InternalsVisibleTo("Shop.UnitTests")]` in the app project - see `infrastructure.md`.
