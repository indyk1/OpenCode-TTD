// Shared helpers for the diagram tests (not a test file itself).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DIAGRAMS_DIR = path.resolve(TEST_DIR, '..');
export const PROJECT_ROOT = path.resolve(DIAGRAMS_DIR, '..', '..');
export const SERVER = path.join(DIAGRAMS_DIR, 'server.mjs');

/** A throwaway project whose path contains a space, with a .opencode folder and nothing else. */
export function makeProject() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'diagrams-'));
  const root = path.join(parent, 'my project');
  mkdirSync(path.join(root, '.opencode'), { recursive: true });
  return { root, cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/** Write `files` ({ 'relative/path': 'text' }) under `root`. */
export function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

const csproj = (sdk, body = '') => `<Project Sdk="${sdk}">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n${body}</Project>\n`;
const refs = (...paths) => `  <ItemGroup>\n${paths.map((p) => `    <ProjectReference Include="${p}" />\n`).join('')}  </ItemGroup>\n`;
const packages = (...names) => `  <ItemGroup>\n${names.map((n) => `    <PackageReference Include="${n}" Version="1.0.0" />\n`).join('')}  </ItemGroup>\n`;

/**
 * The Shop application from the vertical-slices skill, as /setup and a few changes would leave it:
 * - slices Orders/CancelOrder (POST), Orders/PlaceOrder (POST) and Catalog/ListProducts (GET)
 * - Shared/Domain/Money, used by PlaceOrder and ListProducts
 * - Shared/Infrastructure: IEndpoint and EndpointExtensions, Persistence (AppDbContext, Order, OrderLine, OrderStatus,
 *   Product) and Email (IEmailSender, EmailMessage)
 * - an AppHost with PostgreSQL, a database, a secret parameter and the app; ServiceDefaults
 * - acceptance tests: 2 for CancelOrder, 1 for PlaceOrder; unit tests: 1 for CancelOrder; architecture tests
 * - generated code under obj/, which is never read
 */
export const SHOP = {
  'Shop.slnx': '<Solution />\n',
  'src/Shop/Shop.csproj': csproj('Microsoft.NET.Sdk.Web', refs('..\\Shop.ServiceDefaults\\Shop.ServiceDefaults.csproj')),
  'src/Shop/Program.cs': `using Shop.Shared.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
builder.AddServiceDefaults();
builder.Services.AddProblemDetails();
builder.Services.AddEndpoints(typeof(Program).Assembly);
var app = builder.Build();
app.MapDefaultEndpoints();
app.MapEndpoints();
app.Run();
`,
  'src/Shop/obj/Debug/net10.0/Shop.GlobalUsings.g.cs': 'global using global::System;\nnamespace Generated { public class ShouldNotAppear { } }\n',
  'src/Shop/Features/Orders/CancelOrder/CancelOrder.Contracts.cs': `namespace Shop.Features.Orders.CancelOrder;

public static class CancelOrderContracts
{
    public const string Route = "/orders/{orderId:guid}/cancel";

    public static string Path(Guid orderId) => $"/orders/{orderId}/cancel";

    public sealed record Response(Guid OrderId, string Status);
}
`,
  'src/Shop/Features/Orders/CancelOrder/CancelOrder.Endpoint.cs': `using Microsoft.AspNetCore.Http.HttpResults;
using Shop.Shared.Infrastructure;
using Shop.Shared.Infrastructure.Email;
using Shop.Shared.Infrastructure.Persistence;

namespace Shop.Features.Orders.CancelOrder;

public sealed class CancelOrderEndpoint : IEndpoint
{
    public void MapEndpoint(IEndpointRouteBuilder app) =>
        app.MapPost(CancelOrderContracts.Route, Handle);

    internal static async Task<Results<Ok<CancelOrderContracts.Response>, ProblemHttpResult>> Handle(
        Guid orderId, AppDbContext db, IEmailSender email, CancellationToken cancellationToken)
    {
        var order = await db.Orders.FindAsync([orderId], cancellationToken);
        if (order is null)
        {
            return TypedResults.Problem(title: "Order not found", detail: $"There is no order {orderId}.", statusCode: 404);
        }
        if (!CancellationPolicy.CanCancel(order.Status))
        {
            return TypedResults.Problem(title: "Order cannot be cancelled", statusCode: 409);
        }
        order.Status = OrderStatus.Cancelled;
        await db.SaveChangesAsync(cancellationToken);
        await email.SendAsync(new EmailMessage(order.CustomerEmail, "Your order was cancelled", $"Order {order.Id} has been cancelled."), cancellationToken);
        return TypedResults.Ok(new CancelOrderContracts.Response(order.Id, order.Status.ToString()));
    }
}
`,
  'src/Shop/Features/Orders/CancelOrder/CancellationPolicy.cs': `using Shop.Shared.Infrastructure.Persistence;

namespace Shop.Features.Orders.CancelOrder;

internal static class CancellationPolicy
{
    public static bool CanCancel(OrderStatus status) =>
        status is OrderStatus.Placed or OrderStatus.Paid;
}
`,
  'src/Shop/Features/Orders/PlaceOrder/PlaceOrder.Contracts.cs': `namespace Shop.Features.Orders.PlaceOrder;

public static class PlaceOrderContracts
{
    public const string Route = "/orders";

    public sealed record Request(string CustomerEmail, IReadOnlyList<Line> Lines);

    public sealed record Line(Guid ProductId, int Quantity);

    public sealed record Response(Guid OrderId, decimal Total);
}
`,
  'src/Shop/Features/Orders/PlaceOrder/PlaceOrder.Endpoint.cs': `using Microsoft.AspNetCore.Http.HttpResults;
using Shop.Shared.Domain;
using Shop.Shared.Infrastructure;
using Shop.Shared.Infrastructure.Persistence;

namespace Shop.Features.Orders.PlaceOrder;

public sealed class PlaceOrderEndpoint : IEndpoint
{
    public void MapEndpoint(IEndpointRouteBuilder app) => app.MapPost(PlaceOrderContracts.Route, Handle);

    internal static async Task<Created<PlaceOrderContracts.Response>> Handle(PlaceOrderContracts.Request request, AppDbContext db, CancellationToken ct)
    {
        var total = Money.Zero;
        var order = new Order { CustomerEmail = request.CustomerEmail, Status = OrderStatus.Placed };
        db.Orders.Add(order);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/orders/{order.Id}", new PlaceOrderContracts.Response(order.Id, total.Amount));
    }
}
`,
  'src/Shop/Features/Catalog/ListProducts/ListProducts.Contracts.cs': `namespace Shop.Features.Catalog.ListProducts;

public static class ListProductsContracts
{
    public const string Route = "/products";

    public sealed record Response(IReadOnlyList<Item> Items);

    public sealed record Item(Guid Id, string Name, decimal Price);
}
`,
  'src/Shop/Features/Catalog/ListProducts/ListProducts.Endpoint.cs': `using Shop.Shared.Domain;
using Shop.Shared.Infrastructure;
using Shop.Shared.Infrastructure.Persistence;

namespace Shop.Features.Catalog.ListProducts;

public sealed class ListProductsEndpoint : IEndpoint
{
    public void MapEndpoint(IEndpointRouteBuilder app) => app.MapGet(ListProductsContracts.Route, Handle);

    internal static Ok<ListProductsContracts.Response> Handle(AppDbContext db) =>
        TypedResults.Ok(new ListProductsContracts.Response(
            db.Products.Select(p => new ListProductsContracts.Item(p.Id, p.Name, Money.Round(p.Price))).ToList()));
}
`,
  'src/Shop/Shared/Domain/Money.cs': `namespace Shop.Shared.Domain;

/// <summary>An amount of money, rounded the way the shop's prices are.</summary>
public readonly record struct Money(decimal Amount)
{
    public static Money Zero => new(0m);

    public static decimal Round(decimal amount) => Math.Round(amount, 2, MidpointRounding.AwayFromZero);
}
`,
  'src/Shop/Shared/Infrastructure/IEndpoint.cs': `namespace Shop.Shared.Infrastructure;

/// <summary>The HTTP entry point of a vertical slice.</summary>
public interface IEndpoint
{
    void MapEndpoint(IEndpointRouteBuilder app);
}
`,
  'src/Shop/Shared/Infrastructure/EndpointExtensions.cs': `using System.Reflection;

namespace Shop.Shared.Infrastructure;

public static class EndpointExtensions
{
    public static IServiceCollection AddEndpoints(this IServiceCollection services, Assembly assembly) => services;

    public static WebApplication MapEndpoints(this WebApplication app)
    {
        foreach (var endpoint in app.Services.GetRequiredService<IEnumerable<IEndpoint>>())
        {
            endpoint.MapEndpoint(app);
        }
        return app;
    }
}
`,
  'src/Shop/Shared/Infrastructure/Persistence/AppDbContext.cs': `using Microsoft.EntityFrameworkCore;

namespace Shop.Shared.Infrastructure.Persistence;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();

    public DbSet<Product> Products => Set<Product>();
}
`,
  'src/Shop/Shared/Infrastructure/Persistence/Order.cs': `namespace Shop.Shared.Infrastructure.Persistence;

public sealed class Order
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required string CustomerEmail { get; init; }
    public OrderStatus Status { get; set; }
    public List<OrderLine> Lines { get; } = [];
}

public sealed class OrderLine
{
    public Guid ProductId { get; init; }
    public int Quantity { get; init; }
}

public enum OrderStatus
{
    Placed,
    Paid,
    Shipped,
    Cancelled,
}
`,
  'src/Shop/Shared/Infrastructure/Persistence/Product.cs': `namespace Shop.Shared.Infrastructure.Persistence;

public sealed class Product
{
    public Guid Id { get; init; }
    public string Name { get; set; } = "";
    public decimal Price { get; set; }
}
`,
  'src/Shop/Shared/Infrastructure/Email/IEmailSender.cs': `namespace Shop.Shared.Infrastructure.Email;

public interface IEmailSender
{
    Task SendAsync(EmailMessage message, CancellationToken cancellationToken);
}

public sealed record EmailMessage(string To, string Subject, string Body);
`,
  'src/Shop.AppHost/Shop.AppHost.csproj': csproj('Aspire.AppHost.Sdk/13.0.0', refs('..\\Shop\\Shop.csproj') + packages('Aspire.Hosting.PostgreSQL')),
  'src/Shop.AppHost/AppHost.cs': `var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres").WithDataVolume();
var database = postgres.AddDatabase("shopdb");
var paymentsKey = builder.AddParameter("payments-api-key", secret: true);

builder.AddProject<Projects.Shop>("shop")
    .WithExternalHttpEndpoints()
    .WithReference(database)
    .WaitFor(database)
    .WithEnvironment("Payments__ApiKey", paymentsKey);

builder.AddAzureContainerAppEnvironment("env");

builder.Build().Run();
`,
  'src/Shop.ServiceDefaults/Shop.ServiceDefaults.csproj': csproj('Microsoft.NET.Sdk', '  <PropertyGroup>\n    <IsAspireSharedProject>true</IsAspireSharedProject>\n  </PropertyGroup>\n'),
  'src/Shop.ServiceDefaults/Extensions.cs': `namespace Microsoft.Extensions.Hosting;

public static class Extensions
{
    public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder) where TBuilder : IHostApplicationBuilder => builder;
}
`,
  'tests/Shop.AcceptanceTests/Shop.AcceptanceTests.csproj': csproj('Microsoft.NET.Sdk', refs('..\\..\\src\\Shop\\Shop.csproj') + packages('NUnit', 'NSubstitute')),
  'tests/Shop.AcceptanceTests/AcceptanceTest.cs': `namespace Shop.AcceptanceTests;

public abstract class AcceptanceTest
{
    protected HttpClient Client { get; private set; } = null!;
}
`,
  'tests/Shop.AcceptanceTests/Features/Orders/CancelOrderTests.cs': `using System.Net;
using Shop.Features.Orders.CancelOrder;

namespace Shop.AcceptanceTests.Features.Orders;

public sealed class CancelOrderTests : AcceptanceTest
{
    // GIVEN a placed order WHEN the customer cancels it THEN it is cancelled
    [Test]
    [Property("Scenario", "orders/cancel-order: Cancel a placed order")]
    public async Task Cancel_a_placed_order()
    {
        var response = await Client.PostAsync(CancelOrderContracts.Path(Guid.NewGuid()), null);
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
    }

    [Test]
    [Property("Scenario", "orders/cancel-order: A shipped order cannot be cancelled")]
    public async Task A_shipped_order_cannot_be_cancelled()
    {
        var response = await Client.PostAsync(CancelOrderContracts.Path(Guid.NewGuid()), null);
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Conflict));
    }
}
`,
  'tests/Shop.AcceptanceTests/Features/Orders/PlaceOrderTests.cs': `using Shop.Features.Orders.PlaceOrder;

namespace Shop.AcceptanceTests.Features.Orders;

public sealed class PlaceOrderTests : AcceptanceTest
{
    [Test]
    [Property("Scenario", "orders/place-order: Place an order")]
    public async Task Place_an_order()
    {
        var response = await Client.PostAsJsonAsync(PlaceOrderContracts.Route, new PlaceOrderContracts.Request("a@b.c", []));
        Assert.That(response.IsSuccessStatusCode, Is.True);
    }
}
`,
  'tests/Shop.UnitTests/Shop.UnitTests.csproj': csproj('Microsoft.NET.Sdk', refs('..\\..\\src\\Shop\\Shop.csproj') + packages('NUnit')),
  'tests/Shop.UnitTests/Features/Orders/CancelOrder/CancellationPolicyTests.cs': `using Shop.Features.Orders.CancelOrder;
using Shop.Shared.Infrastructure.Persistence;

namespace Shop.UnitTests.Features.Orders.CancelOrder;

public sealed class CancellationPolicyTests
{
    [TestCase(OrderStatus.Placed, true)]
    [TestCase(OrderStatus.Shipped, false)]
    public void Only_orders_that_have_not_shipped_can_be_cancelled(OrderStatus status, bool expected) =>
        Assert.That(CancellationPolicy.CanCancel(status), Is.EqualTo(expected));
}
`,
  'tests/Shop.ArchitectureTests/Shop.ArchitectureTests.csproj': csproj('Microsoft.NET.Sdk', refs('..\\..\\src\\Shop\\Shop.csproj') + packages('NUnit', 'TngTech.ArchUnitNET')),
  'tests/Shop.ArchitectureTests/SliceTests.cs': `namespace Shop.ArchitectureTests;

public sealed class SliceTests
{
    [Test]
    public void Slices_do_not_reference_other_slices() { }
}
`,
};

/** A project with the Shop application in it. */
export function makeShop(extra = {}) {
  const project = makeProject();
  writeFiles(project.root, { ...SHOP, ...extra });
  return project;
}

/** Start server.mjs in the foreground on a random port and wait for its "running at" line. */
export function startServer({ root, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--root', root, '--port', '0', '--no-open', '--idle-minutes', '0', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}${err}`)), 5000);
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      out += d;
      const m = /running at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        const port = Number(m[1]);
        resolve({ child, port, url: `http://127.0.0.1:${port}`, stop: () => stopChild(child) });
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}${err}`)));
  });
}

export function waitForExit(child, ms = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit')), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForExit(child).catch(() => child.kill('SIGKILL'));
}

/** Raw HTTP request (fetch cannot set Host). Returns { status, headers, text, json }. */
export function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
