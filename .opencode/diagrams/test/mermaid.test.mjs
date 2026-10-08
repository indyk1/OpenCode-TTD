import test from 'node:test';
import assert from 'node:assert/strict';
import { architectureDiagram, classDiagram, classScopes, escapeLabel } from '../mermaid.mjs';
import { readModel } from '../model.mjs';
import { makeProject, makeShop } from './_helpers.mjs';

function shop(t, extra) {
  const project = makeShop(extra);
  t.after(() => project.cleanup());
  return readModel(project.root);
}

const linesOf = (text) => text.split('\n').map((l) => l.trim());

test('labels escape what Mermaid would read as syntax', () => {
  assert.equal(escapeLabel('Results<Ok<T>, "x"> & #1 `y`'), 'Results#lt;Ok#lt;T#gt;, #quot;x#quot;#gt; #amp; #35;1 #96;y#96;');
  assert.equal(escapeLabel('a\r\nb'), 'a b');
});

test('the architecture diagram shows the AppHost, the slices with routes and tests, shared code and test projects', (t) => {
  const { mermaid, summary } = architectureDiagram(shop(t));
  const lines = linesOf(mermaid);
  assert.equal(lines[0], 'flowchart LR');
  for (const expected of [
    'subgraph host_Shop_AppHost["Shop.AppHost · what runs"]',
    'res_Shop_AppHost_postgres[("postgres<br/>PostgreSQL")]',
    'res_Shop_AppHost_payments_api_key{{"payments-api-key<br/>secret setting"}}',
    'res_Shop_AppHost_shop[["shop<br/>runs Shop"]]',
    'res_Shop_AppHost_env[/"env<br/>Azure Container Apps"\\]',
    'subgraph app_Shop["Shop · application"]',
    'subgraph area_Shop_Orders["Orders"]',
    'slice_Shop_Orders_CancelOrder["CancelOrder<br/>POST /orders/{orderId:guid}/cancel<br/>2 acceptance tests · 1 unit test"]',
    'slice_Shop_Catalog_ListProducts["ListProducts<br/>GET /products<br/>no tests yet"]',
    'rule_Shop_Shared_Domain_Money(["Money"])',
    'plumbing_Shop_Persistence["Persistence<br/>AppDbContext, Order, OrderLine, OrderStatus, Product"]',
    'project_Shop_AcceptanceTests["Shop.AcceptanceTests<br/>acceptance tests · 3 tests"]',
    'slice_Shop_Orders_PlaceOrder --> rule_Shop_Shared_Domain_Money',
    'slice_Shop_Orders_CancelOrder --> plumbing_Shop_Email',
    'res_Shop_AppHost_postgres --- res_Shop_AppHost_shopdb',
    'res_Shop_AppHost_shop -->|uses| res_Shop_AppHost_shopdb',
    'res_Shop_AppHost_shop ==>|runs| app_Shop',
    'app_Shop -.-> project_Shop_ServiceDefaults',
    'project_Shop_UnitTests -.->|tests| app_Shop',
  ]) {
    assert.ok(lines.includes(expected), `missing: ${expected}\n${mermaid}`);
  }
  assert.ok(!mermaid.includes('waits for'), 'a resource it also references is drawn once');
  assert.ok(!mermaid.includes('linkStyle'));
  assert.deepEqual(summary, { projects: 6, resources: 5, areas: 2, slices: 3, sharedRules: 1, acceptanceTests: 3, crossSliceReferences: 0 });
});

test('a slice using another slice is drawn in red', (t) => {
  const model = shop(t, {
    'src/Shop/Features/Catalog/ListProducts/Featured.cs':
      'using Shop.Features.Orders.PlaceOrder;\nnamespace Shop.Features.Catalog.ListProducts;\ninternal static class Featured { public static string Link => PlaceOrderContracts.Route; }\n',
  });
  const { mermaid, summary } = architectureDiagram(model);
  const lines = linesOf(mermaid);
  const edges = lines.filter((l) => / (-->|---|==>|-\.->)/.test(l));
  const red = edges.findIndex((l) => l === 'slice_Shop_Catalog_ListProducts -.->|not allowed| slice_Shop_Orders_PlaceOrder');
  assert.ok(red >= 0, mermaid);
  assert.equal(lines.at(-2), `linkStyle ${red} stroke:#dc2626,stroke-width:2px,color:#dc2626`);
  assert.equal(summary.crossSliceReferences, 1);
});

test('a project with no .NET code yet gets a one-node diagram', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const { mermaid, summary } = architectureDiagram(readModel(project.root));
  assert.equal(mermaid, 'flowchart LR\n  empty["No .NET projects yet<br/>/setup creates the application"]\n');
  assert.equal(summary.projects, 0);
});

test('class scopes: each project, and in the app each area, slice and the shared code', (t) => {
  const scopes = classScopes(shop(t));
  assert.deepEqual(scopes.map((s) => `${s.id} | ${s.label} | ${s.count}`), [
    'project:Shop | Everything in Shop | 23',
    'area:Shop/Catalog | Catalog (all slices) | 4',
    'slice:Shop/Catalog/ListProducts | Catalog/ListProducts | 4',
    'area:Shop/Orders | Orders (all slices) | 9',
    'slice:Shop/Orders/CancelOrder | Orders/CancelOrder | 4',
    'slice:Shop/Orders/PlaceOrder | Orders/PlaceOrder | 5',
    'domain:Shop | Shared/Domain | 1',
    'infrastructure:Shop | Shared/Infrastructure | 9',
    'project:Shop.ServiceDefaults | Everything in Shop.ServiceDefaults | 1',
    'project:Shop.AcceptanceTests | Everything in Shop.AcceptanceTests | 3',
    'project:Shop.ArchitectureTests | Everything in Shop.ArchitectureTests | 1',
    'project:Shop.UnitTests | Everything in Shop.UnitTests | 1',
  ]);
});

test('a slice class diagram: members, stereotypes, relations and the related types it uses', (t) => {
  const result = classDiagram(shop(t), { scope: 'slice:Shop/Orders/CancelOrder' });
  assert.deepEqual([result.types, result.related], [4, 5]);
  const lines = linesOf(result.mermaid);
  for (const expected of [
    'classDiagram',
    'namespace Shop.Features.Orders.CancelOrder {',
    'class c_Shop_Features_Orders_CancelOrder_CancelOrderContracts["CancelOrderContracts"] {',
    '<<static>>',
    '+string Route$',
    '+Path(Guid orderId)$ string',
    'class c_Shop_Features_Orders_CancelOrder_CancelOrderContracts_Response["CancelOrderContracts.Response"] {',
    '<<record>>',
    '+Guid OrderId',
    '~Handle(Guid orderId, AppDbContext db, IEmailSender email, CancellationToken cancellationToken)$ Task#lt;Results#lt;Ok#lt;CancelOrderContracts.Response#gt;, ProblemHttpResult#gt;#gt;',
    'class c_Shop_Shared_Infrastructure_IEndpoint["IEndpoint"] {',
    '<<interface>>',
    'c_Shop_Shared_Infrastructure_IEndpoint <|.. c_Shop_Features_Orders_CancelOrder_CancelOrderEndpoint',
    'c_Shop_Features_Orders_CancelOrder_CancelOrderEndpoint ..> c_Shop_Features_Orders_CancelOrder_CancellationPolicy',
    'c_Shop_Features_Orders_CancelOrder_CancellationPolicy ..> c_Shop_Shared_Infrastructure_Persistence_OrderStatus',
  ]) {
    assert.ok(lines.includes(expected), `missing: ${expected}\n${result.mermaid}`);
  }
  // Related types are drawn without members, and marked so the page can fade them.
  assert.ok(lines.includes('class c_Shop_Shared_Infrastructure_Persistence_AppDbContext["AppDbContext"]'));
  assert.match(result.mermaid, /cssClass "[^"]*c_Shop_Shared_Infrastructure_Persistence_AppDbContext[^"]*" related/);
});

test('members and related types can be left out', (t) => {
  const model = shop(t);
  const bare = classDiagram(model, { scope: 'slice:Shop/Orders/PlaceOrder', members: false, related: false });
  assert.equal(bare.related, 0);
  assert.ok(!bare.mermaid.includes('AppDbContext'));
  assert.ok(!bare.mermaid.includes('cssClass'));
  assert.ok(!/[+~#-]\w/.test(bare.mermaid.replace(/c_[\w]+|-->|\.\.>|<\|--|<\|\.\./g, '')), bare.mermaid);
  assert.ok(linesOf(bare.mermaid).includes('c_Shop_Features_Orders_PlaceOrder_PlaceOrderContracts_Request --> "*" c_Shop_Features_Orders_PlaceOrder_PlaceOrderContracts_Line'));
});

test('Shared/Domain shows the slices that use it as related types', (t) => {
  const result = classDiagram(shop(t), { scope: 'domain:Shop' });
  assert.ok(result.mermaid.includes('c_Shop_Features_Orders_PlaceOrder_PlaceOrderEndpoint ..> c_Shop_Shared_Domain_Money'), result.mermaid);
  assert.ok(linesOf(result.mermaid).includes('<<record struct>>'));
  assert.ok(!result.mermaid.includes('Tests'), 'tests are not shown as users of app code');
});

test('enums, generics and tuples are written so Mermaid reads them as intended', (t) => {
  const model = shop(t, {
    'src/Shop/Shared/Domain/Rules.cs': `namespace Shop.Shared.Domain;

public enum Rounding { Up, Down }

public sealed class Result<T>
{
    public (int Count, string Name) Pair { get; }
    public static Result<T> Ok<TOther>(T value, TOther[] others) => new();
}
`,
  });
  const lines = linesOf(classDiagram(model, { scope: 'domain:Shop', related: false }).mermaid);
  for (const expected of ['<<enumeration>>', 'Up', 'Down', 'class c_Shop_Shared_Domain_Result["Result#lt;T#gt;"] {', '+#40;int Count, string Name#41; Pair', '+Ok#lt;TOther#gt;(T value, TOther[] others)$ Result#lt;T#gt;']) {
    assert.ok(lines.includes(expected), `missing: ${expected}\n${lines.join('\n')}`);
  }
});

test('an unknown scope gives null', (t) => {
  const model = shop(t);
  assert.equal(classDiagram(model, { scope: 'slice:Shop/Nope/Nope' }).types, 0);
  assert.equal(classDiagram(model, { scope: 'nonsense' }), null);
});
