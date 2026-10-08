import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSharp, tokenize } from '../csharp.mjs';

const typeNamed = (result, path) => result.types.find((t) => t.path === path);
const memberNames = (type) => type.members.map((m) => `${m.kind}:${m.name}`);

test('strings, characters and comments never leak braces or names into the code', () => {
  const tokens = tokenize(String.raw`
    // a } comment
    /* another { one */
    #region Not code {
    var a = "x { \" }";
    var b = @"y { "" }";
    var c = $"z {(flag ? "{" : "}")} {{ }}";
    var d = """
        raw { "" }
        """;
    var e = '}';
    #endregion
  `);
  const punctuation = tokens.filter((t) => t.k === 'p' && (t.v === '{' || t.v === '}'));
  assert.deepEqual(punctuation, []);
  const strings = tokens.filter((t) => t.k === 'str').map((t) => t.v);
  assert.deepEqual(strings, ['x { " }', 'y { " }', 'z {…} { }', 'raw { "" }']);
  assert.equal(tokens.find((t) => t.k === 'chr').v, '}');
  assert.equal(tokens.at(-1).line, 11);
});

test('a slice contract: file-scoped namespace, static class, constant, method and nested records', () => {
  const r = parseCSharp(`
    namespace Shop.Features.Orders.CancelOrder;

    public static class CancelOrderContracts
    {
        public const string Route = "/orders/{orderId:guid}/cancel";
        public static string Path(Guid orderId) => $"/orders/{orderId}/cancel";
        public sealed record Response(Guid OrderId, string Status);
    }
  `);
  const contracts = typeNamed(r, 'CancelOrderContracts');
  assert.equal(contracts.namespace, 'Shop.Features.Orders.CancelOrder');
  assert.deepEqual([contracts.kind, contracts.visibility, contracts.modifiers], ['class', 'public', ['public', 'static']]);
  assert.deepEqual(memberNames(contracts), ['field:Route', 'method:Path']);
  assert.ok(contracts.members.every((m) => m.static));
  const response = typeNamed(r, 'CancelOrderContracts.Response');
  assert.deepEqual([response.kind, response.parent], ['record', 'CancelOrderContracts']);
  assert.deepEqual(response.parameters.map((p) => `${p.type.text} ${p.name}`), ['Guid OrderId', 'string Status']);
});

test('members: properties, fields, events, indexers, constructors, operators and generic methods', () => {
  const r = parseCSharp(`
    namespace Shop;
    public sealed class Basket : IDisposable
    {
        private readonly Dictionary<int, List<Line>> _lines = new Dictionary<int, List<Line>>(), _spare = new();
        public int Count { get; private set; } = 3;
        public string Label => $"{Count} items";
        public event EventHandler<BasketChanged>? Changed;
        public Line this[int index] => _lines[index][0];
        public Basket(IClock clock) : base() { }
        ~Basket() { }
        public static Basket operator +(Basket a, Line b) => a;
        public static implicit operator int(Basket b) => b.Count;
        void IDisposable.Dispose() { }
        public T Get<T>(string key) where T : class, new() => default!;
        protected abstract Task<IReadOnlyList<Line>> LoadAsync(CancellationToken ct = default);
    }
  `);
  const basket = typeNamed(r, 'Basket');
  assert.deepEqual(memberNames(basket), [
    'field:_lines', 'field:_spare', 'property:Count', 'property:Label', 'event:Changed', 'indexer:this[]',
    'constructor:Basket', 'operator:operator', 'operator:operator', 'method:Dispose', 'method:Get', 'method:LoadAsync',
  ]);
  const byName = (n) => basket.members.find((m) => m.name === n);
  assert.equal(byName('_lines').type.text, 'Dictionary<int, List<Line>>');
  assert.deepEqual(byName('_lines').type.refs, [
    { name: 'Dictionary', many: false },
    { name: 'int', many: true },
    { name: 'List', many: true },
    { name: 'Line', many: true },
  ]);
  assert.equal(byName('Changed').type.text, 'EventHandler<BasketChanged>?');
  assert.deepEqual(byName('Get').typeParams, ['T']);
  const load = byName('LoadAsync');
  assert.deepEqual([load.visibility, load.abstract, load.type.text], ['protected', true, 'Task<IReadOnlyList<Line>>']);
  assert.deepEqual(load.params.map((p) => `${p.type.text} ${p.name}`), ['CancellationToken ct']);
  assert.equal(byName('Dispose').visibility, 'private');
});

test('bodies are skipped but the type names they use are kept', () => {
  const r = parseCSharp(`
    namespace Shop.Features.Orders.CancelOrder;
    public sealed class CancelOrderEndpoint : IEndpoint
    {
        internal static async Task<Results<Ok<CancelOrderContracts.Response>, ProblemHttpResult>> Handle(Guid orderId, AppDbContext db)
        {
            var order = await db.Orders.FindAsync([orderId]);
            if (!CancellationPolicy.CanCancel(order.Status)) return TypedResults.Problem(title: "No { way");
            order.Status = OrderStatus.Cancelled;
            return TypedResults.Ok(new CancelOrderContracts.Response(order.Id, order.Status.ToString()));
        }
    }
  `);
  const handle = typeNamed(r, 'CancelOrderEndpoint').members[0];
  assert.deepEqual(handle.refs, ['CancellationPolicy.CanCancel', 'TypedResults.Problem', 'OrderStatus.Cancelled', 'TypedResults.Ok', 'CancelOrderContracts.Response']);
  assert.deepEqual(handle.type.refs.map((x) => x.name), ['Task', 'Results', 'Ok', 'CancelOrderContracts.Response', 'ProblemHttpResult']);
  assert.deepEqual(typeNamed(r, 'CancelOrderEndpoint').bases.map((b) => b.text), ['IEndpoint']);
});

test('block namespaces, enums, delegates, generics, record structs, interfaces, attributes and docs', () => {
  const r = parseCSharp(`
    using System.Text.Json;
    using static System.Math;
    using Db = Shop.Persistence.AppDbContext;
    global using Shop.Shared;
    [assembly: InternalsVisibleTo("Shop.UnitTests")]
    namespace Shop
    {
        namespace Domain
        {
            /// <summary>Money, rounded like <see cref="Prices"/> are.</summary>
            [Serializable]
            public readonly record struct Money(decimal Amount) : IComparable<Money>
            {
                public int CompareTo(Money other) => Amount.CompareTo(other.Amount);
            }
            public enum Status { Placed = 1, [Description("p")] Paid, Shipped }
            public delegate Task Handler<in T>(T message, CancellationToken ct);
            public abstract class Entity<TId> where TId : notnull { public TId Id { get; init; } = default!; }
            public interface IClock { DateTimeOffset UtcNow { get; } }
        }
    }
  `);
  assert.deepEqual(r.usings, ['System.Text.Json']);
  assert.deepEqual(r.globalUsings, ['Shop.Shared']);
  assert.deepEqual(r.aliases, { Db: 'Shop.Persistence.AppDbContext' });
  const money = typeNamed(r, 'Money');
  assert.deepEqual([money.namespace, money.kind, money.doc], ['Shop.Domain', 'record struct', 'Money, rounded like Prices are.']);
  assert.deepEqual(money.attributes, [{ name: 'Serializable', args: [] }]);
  assert.deepEqual(memberNames(typeNamed(r, 'Status')), ['value:Placed', 'value:Paid', 'value:Shipped']);
  const handler = typeNamed(r, 'Handler');
  assert.deepEqual([handler.kind, handler.typeParams, memberNames(handler)], ['delegate', ['T'], ['method:Invoke']]);
  assert.deepEqual(typeNamed(r, 'Entity').typeParams, ['TId']);
  const clock = typeNamed(r, 'IClock');
  assert.deepEqual([clock.kind, clock.members[0].visibility], ['interface', 'public']);
});

test('top-level statements are kept for the AppHost, and types after them are still found', () => {
  const r = parseCSharp(`
    using Shop.Shared.Infrastructure;
    var builder = WebApplication.CreateBuilder(args);
    builder.Services.AddEndpoints(o => { o.Enabled = true; });
    if (builder.Environment.IsDevelopment()) { Console.WriteLine("dev"); } else { Console.WriteLine("prod"); }
    var app = builder.Build();
    app.Run();
    public partial class Program { }
  `);
  assert.equal(r.statements.length, 6);
  assert.deepEqual(r.statements[0].slice(0, 4).map((t) => t.v), ['var', 'builder', '=', 'WebApplication']);
  assert.deepEqual(r.types.map((t) => t.path), ['Program']);
});

test('attributes on test methods are read with their string arguments', () => {
  const r = parseCSharp(`
    public sealed class CancelOrderTests
    {
        [Test]
        [Property("Scenario", "orders/cancel-order: Cancel a placed order")]
        public async Task Cancel_a_placed_order() { }

        [TestCase(1, "a"), TestCase(2, "b")]
        public void Cases(int n, string s) { }
    }
  `);
  const [one, two] = typeNamed(r, 'CancelOrderTests').members;
  assert.deepEqual(one.attributes, [{ name: 'Test', args: [] }, { name: 'Property', args: ['Scenario', 'orders/cancel-order: Cancel a placed order'] }]);
  assert.deepEqual(two.attributes.map((a) => a.name), ['TestCase', 'TestCase']);
});

test('code it cannot follow is skipped without throwing', () => {
  for (const source of ['', '}}}', 'class', 'public class { int', 'namespace ;', 'class A { void M( { } }', '"unterminated', '$"{', 'class B : { }', 'record']) {
    assert.doesNotThrow(() => parseCSharp(source), source);
  }
  const r = parseCSharp('class A { int x = ; } class B { }');
  assert.deepEqual(r.types.map((t) => t.name), ['A', 'B']);
});
