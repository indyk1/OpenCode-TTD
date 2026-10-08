import test from 'node:test';
import assert from 'node:assert/strict';
import { readModel } from '../model.mjs';
import { makeProject, makeShop, writeFiles } from './_helpers.mjs';

function shop(t, extra) {
  const project = makeShop(extra);
  t.after(() => project.cleanup());
  return readModel(project.root);
}

const type = (model, key) => model.types.find((t) => t.key === key);
const relations = (model, key) => type(model, key).relations.map((r) => `${r.kind} ${r.to.split('.').pop()}${r.many ? ' *' : ''}`).sort();

test('finds each project and what kind it is, and never reads bin or obj', (t) => {
  const model = shop(t);
  assert.deepEqual(
    model.projects.map((p) => [p.name, p.kind, p.testKind, p.references]),
    [
      ['Shop.AppHost', 'apphost', null, ['Shop']],
      ['Shop.ServiceDefaults', 'servicedefaults', null, []],
      ['Shop', 'app', null, ['Shop.ServiceDefaults']],
      ['Shop.AcceptanceTests', 'tests', 'acceptance', ['Shop']],
      ['Shop.ArchitectureTests', 'tests', 'architecture', ['Shop']],
      ['Shop.UnitTests', 'tests', 'unit', ['Shop']],
    ],
  );
  assert.equal(model.projects.find((p) => p.name === 'Shop').dir, 'src/Shop');
  assert.ok(!model.types.some((t) => t.namespace === 'Generated'));
  assert.deepEqual(model.warnings, []);
});

test('lists each slice with its route, HTTP method and tests, like the overview script', (t) => {
  const model = shop(t);
  assert.deepEqual(
    model.slices.map((s) => [s.key, s.method, s.route, s.tests.acceptance, s.tests.unit]),
    [
      ['Shop/Catalog/ListProducts', 'GET', '/products', 0, 0],
      ['Shop/Orders/CancelOrder', 'POST', '/orders/{orderId:guid}/cancel', 2, 1],
      ['Shop/Orders/PlaceOrder', 'POST', '/orders', 1, 0],
    ],
  );
  assert.deepEqual(model.projects.filter((p) => p.kind === 'tests').map((p) => p.tests), [3, 1, 1]);
});

test('records what each slice uses: shared rules, plumbing (not the IEndpoint it implements) and no other slice', (t) => {
  const model = shop(t);
  const uses = Object.fromEntries(model.slices.map((s) => [s.name, s.uses]));
  assert.deepEqual(uses.CancelOrder, { domain: [], infrastructure: ['Email', 'Persistence'], slices: [] });
  assert.deepEqual(uses.PlaceOrder, { domain: ['Shop.Shared.Domain.Money'], infrastructure: ['Persistence'], slices: [] });
  assert.deepEqual(model.domain, ['Shop.Shared.Domain.Money']);
  assert.deepEqual(model.infrastructure.map((g) => [g.group, g.types.length]), [['', 2], ['Email', 2], ['Persistence', 5]]);
});

test('a slice that uses another slice is recorded, so the diagram can show it', (t) => {
  const model = shop(t, {
    'src/Shop/Features/Catalog/ListProducts/Featured.cs': `using Shop.Features.Orders.PlaceOrder;

namespace Shop.Features.Catalog.ListProducts;

internal static class Featured
{
    public static string OrderLink => PlaceOrderContracts.Route;
}
`,
  });
  assert.deepEqual(model.slices.find((s) => s.name === 'ListProducts').uses.slices, ['Shop/Orders/PlaceOrder']);
});

test('resolves names through namespaces, usings, nesting and qualification', (t) => {
  const model = shop(t);
  assert.deepEqual(relations(model, 'Shop.Features.Orders.CancelOrder.CancelOrderEndpoint'), [
    'implements IEndpoint',
    'uses AppDbContext',
    'uses CancelOrderContracts',
    'uses CancellationPolicy',
    'uses EmailMessage',
    'uses IEmailSender',
    'uses OrderStatus',
    'uses Response',
  ]);
  const response = type(model, 'Shop.Features.Orders.CancelOrder.CancelOrderEndpoint').relations.find((r) => r.to.endsWith('Response'));
  assert.equal(response.to, 'Shop.Features.Orders.CancelOrder.CancelOrderContracts.Response');
  assert.deepEqual(relations(model, 'Shop.Shared.Infrastructure.Persistence.Order'), ['has OrderLine *', 'has OrderStatus']);
  assert.deepEqual(relations(model, 'Shop.Shared.Infrastructure.Persistence.AppDbContext'), ['has Order *', 'has Product *']);
  assert.deepEqual(relations(model, 'Shop.Features.Orders.PlaceOrder.PlaceOrderContracts.Request'), ['has Line *']);
  assert.deepEqual(relations(model, 'Shop.AcceptanceTests.Features.Orders.CancelOrderTests'), ['inherits AcceptanceTest', 'uses CancelOrderContracts']);
});

test('places each type: slice, Shared/Domain, an Infrastructure group, or elsewhere', (t) => {
  const model = shop(t);
  const where = (key) => {
    const x = type(model, key);
    return [x.layer, x.area, x.slice, x.group, x.project, x.file];
  };
  assert.deepEqual(where('Shop.Features.Orders.CancelOrder.CancellationPolicy'), [
    'slice', 'Orders', 'CancelOrder', null, 'Shop', 'src/Shop/Features/Orders/CancelOrder/CancellationPolicy.cs',
  ]);
  assert.deepEqual(where('Shop.Shared.Domain.Money').slice(0, 1), ['domain']);
  assert.deepEqual(where('Shop.Shared.Infrastructure.Email.EmailMessage').slice(0, 4), ['infrastructure', null, null, 'Email']);
  assert.deepEqual(where('Shop.Shared.Infrastructure.IEndpoint').slice(0, 4), ['infrastructure', null, null, '']);
  assert.deepEqual(where('Shop.UnitTests.Features.Orders.CancelOrder.CancellationPolicyTests').slice(0, 3), ['other', null, null]);
});

test('reads what the AppHost runs and how the resources connect', (t) => {
  const model = shop(t);
  assert.deepEqual(
    model.resources.map((r) => [r.name, r.kind, r.shape, r.parent, r.project, r.secret, r.references, r.waitsFor, r.settings]),
    [
      ['postgres', 'Postgres', 'data', null, null, false, [], [], []],
      ['shopdb', 'Database', 'data', 'Shop.AppHost/postgres', null, false, [], [], []],
      ['payments-api-key', 'Parameter', 'setting', null, null, true, [], [], []],
      ['shop', 'Project', 'app', null, 'Shop', false, ['Shop.AppHost/shopdb'], ['Shop.AppHost/shopdb'], ['Shop.AppHost/payments-api-key']],
      ['env', 'AzureContainerAppEnvironment', 'deploy', null, null, false, [], [], []],
    ],
  );
});

test('partial types are merged into one', (t) => {
  const model = shop(t, {
    'src/Shop/Shared/Infrastructure/Persistence/AppDbContext.Customers.cs': `namespace Shop.Shared.Infrastructure.Persistence;

public sealed partial class Clock
{
    public DateTimeOffset Now { get; set; }
}
`,
    'src/Shop/Shared/Infrastructure/Persistence/Clock.cs': `namespace Shop.Shared.Infrastructure.Persistence;

public sealed partial class Clock
{
    public Order? Last { get; set; }
}
`,
  });
  const clocks = model.types.filter((x) => x.name === 'Clock');
  assert.equal(clocks.length, 1);
  assert.deepEqual(clocks[0].members.map((m) => m.name).sort(), ['Last', 'Now']);
  assert.deepEqual(relations(model, 'Shop.Shared.Infrastructure.Persistence.Clock'), ['has Order']);
});

test('a project with no .NET code yet gives an empty model', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  writeFiles(project.root, { 'openspec/config.yaml': 'schema: vsa-tdd\n', 'README.md': '# x\n' });
  const model = readModel(project.root);
  assert.deepEqual([model.projects, model.types, model.slices, model.resources, model.warnings], [[], [], [], [], []]);
});

test('a .csproj at the root works, with Features straight under it', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  writeFiles(project.root, {
    'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
    'Features/Todos/AddTodo/AddTodo.Contracts.cs': 'namespace Api.Features.Todos.AddTodo;\npublic static class AddTodoContracts { public const string Route = "/todos"; }\n',
    'Features/Todos/AddTodo/AddTodo.Endpoint.cs': 'namespace Api.Features.Todos.AddTodo;\npublic sealed class AddTodoEndpoint { public void Map(IEndpointRouteBuilder app) => app.MapPost(AddTodoContracts.Route, () => 1); }\n',
  });
  const model = readModel(project.root);
  assert.deepEqual(model.projects.map((p) => [p.name, p.dir, p.kind]), [['Api', '.', 'app']]);
  assert.deepEqual(model.slices.map((s) => [s.key, s.dir, s.method, s.route, s.types.length]), [['Api/Todos/AddTodo', 'Features/Todos/AddTodo', 'POST', '/todos', 2]]);
});
