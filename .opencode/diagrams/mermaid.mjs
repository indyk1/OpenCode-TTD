// Turns the model from model.mjs into Mermaid text: the architecture flowchart behind /diagram and the class diagrams
// behind /classes. Pure functions of the model, so the page, the .mmd downloads and `server.mjs --mermaid` all show
// the same thing. Node built-ins only.

const MAX_LISTED = 5;

/** Text inside a quoted flowchart label, or a class diagram label or member. */
export function escapeLabel(text) {
  return String(text)
    .replace(/#/g, '#35;')
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/`/g, '#96;')
    .replace(/[\r\n]+/g, ' ');
}

/** A class diagram member line: brackets that Mermaid would read as a method or a class body are escaped too. */
function escapeMember(text) {
  return escapeLabel(text).replace(/\(/g, '#40;').replace(/\)/g, '#41;').replace(/\{/g, '#123;').replace(/\}/g, '#125;').replace(/~/g, '#126;');
}

/** Hands out Mermaid ids that are unique and safe, keeping them readable. */
function idMaker() {
  const used = new Set();
  const byKey = new Map();
  return (prefix, key) => {
    const k = `${prefix}:${key}`;
    if (byKey.has(k)) return byKey.get(k);
    const base = `${prefix}_${String(key).replace(/`\d+$/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    byKey.set(k, id);
    return id;
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (names) => (names.length > MAX_LISTED ? `${names.slice(0, MAX_LISTED).join(', ')} +${names.length - MAX_LISTED} more` : names.join(', '));
const label = (...lines) => `"${lines.filter((l) => l !== null && l !== undefined && l !== '').map(escapeLabel).join('<br/>')}"`;

// ---------------------------------------------------------------------------
// Architecture (/diagram)
// ---------------------------------------------------------------------------

const RESOURCE_SHAPES = {
  app: (id, text) => `${id}[[${text}]]`,
  data: (id, text) => `${id}[(${text})]`,
  queue: (id, text) => `${id}[/${text}/]`,
  setting: (id, text) => `${id}{{${text}}}`,
  deploy: (id, text) => `${id}[/${text}\\]`,
  other: (id, text) => `${id}(${text})`,
};

/**
 * The whole application on one page: what the AppHost runs, each app project with its feature areas and slices
 * (route and tests), its shared business rules and plumbing, and the test projects. Returns { mermaid, summary }.
 */
export function architectureDiagram(model) {
  const id = idMaker();
  const lines = ['flowchart LR'];
  const edges = [];
  const red = [];
  const edge = (text, violation = false) => {
    if (violation) red.push(edges.length);
    edges.push(`  ${text}`);
  };
  const byKey = new Map(model.types.map((t) => [t.key, t]));
  const nodeOfProject = new Map();

  if (!model.projects.length) {
    lines.push(`  empty[${label('No .NET projects yet', '/setup creates the application')}]`);
    return { mermaid: `${lines.join('\n')}\n`, summary: summarize(model) };
  }

  // Projects: an app project with slices or shared code is a box of its own; the rest are single nodes.
  const apps = model.projects.filter((p) => p.kind === 'app');
  for (const p of apps) {
    const slices = model.slices.filter((s) => s.project === p.name);
    const domain = model.domain.map((k) => byKey.get(k)).filter((t) => t.project === p.name);
    const infra = model.infrastructure.filter((g) => g.project === p.name);
    const pid = id('app', p.name);
    nodeOfProject.set(p.name, pid);
    if (!slices.length && !domain.length && !infra.length) {
      lines.push(`  ${pid}[${label(p.name, 'application code')}]`);
      continue;
    }
    lines.push(`  subgraph ${pid}[${label(`${p.name} · application`)}]`);
    const areas = [...new Set(slices.map((s) => s.area))];
    for (const area of areas) {
      lines.push(`    subgraph ${id('area', `${p.name}/${area}`)}[${label(area)}]`);
      for (const s of slices.filter((x) => x.area === area)) {
        const route = s.route ? `${s.method ?? '?'} ${s.route}` : s.method ? s.method : 'no route yet';
        const tests = s.tests.acceptance || s.tests.unit
          ? [s.tests.acceptance && plural(s.tests.acceptance, 'acceptance test'), s.tests.unit && plural(s.tests.unit, 'unit test')].filter(Boolean).join(' · ')
          : 'no tests yet';
        lines.push(`      ${id('slice', s.key)}[${label(s.name, route, tests)}]`);
      }
      lines.push('    end');
    }
    if (domain.length) {
      lines.push(`    subgraph ${id('domain', p.name)}[${label('Shared/Domain')}]`);
      for (const t of domain) lines.push(`      ${id('rule', t.key)}([${label(t.path)}])`);
      lines.push('    end');
    }
    if (infra.length) {
      lines.push(`    subgraph ${id('infra', p.name)}[${label('Shared/Infrastructure')}]`);
      for (const g of infra) {
        const names = g.types.map((k) => byKey.get(k)).filter((t) => !t.parentPath).map((t) => t.name);
        lines.push(`      ${id('plumbing', `${p.name}/${g.group}`)}[${label(g.group, listed(names))}]`);
      }
      lines.push('    end');
    }
    lines.push('  end');

    for (const s of slices) {
      const sid = id('slice', s.key);
      for (const k of s.uses.domain) edge(`${sid} --> ${id('rule', k)}`);
      for (const g of s.uses.infrastructure) edge(`${sid} --> ${id('plumbing', `${p.name}/${g}`)}`);
      for (const other of s.uses.slices) edge(`${sid} -.->|not allowed| ${id('slice', other)}`, true);
    }
  }

  for (const p of model.projects.filter((x) => x.kind === 'servicedefaults')) {
    const pid = id('project', p.name);
    nodeOfProject.set(p.name, pid);
    lines.push(`  ${pid}[${label(p.name, 'health, telemetry, resilience')}]`);
  }

  const tests = model.projects.filter((p) => p.kind === 'tests');
  if (tests.length) {
    lines.push(`  subgraph ${id('group', 'tests')}[${label('Tests')}]`);
    for (const p of tests) {
      const pid = id('project', p.name);
      nodeOfProject.set(p.name, pid);
      const what = { acceptance: 'acceptance tests', unit: 'unit tests', architecture: 'architecture rules' }[p.testKind] ?? 'tests';
      lines.push(`    ${pid}[${label(p.name, `${what} · ${plural(p.tests, 'test')}`)}]`);
    }
    lines.push('  end');
  }

  // The AppHost and what it runs.
  for (const host of model.projects.filter((p) => p.kind === 'apphost')) {
    const hid = id('host', host.name);
    nodeOfProject.set(host.name, hid);
    const resources = model.resources.filter((r) => r.host === host.name);
    if (!resources.length) {
      lines.push(`  ${hid}[${label(`${host.name} · what runs`)}]`);
      continue;
    }
    lines.push(`  subgraph ${hid}[${label(`${host.name} · what runs`)}]`);
    for (const r of resources) {
      const kind = r.kind === 'Project' ? `runs ${r.project ?? 'a project'}` : r.secret ? `secret ${r.label}` : r.label;
      lines.push(`    ${RESOURCE_SHAPES[r.shape](id('res', r.id), label(r.name, kind))}`);
    }
    lines.push('  end');
    for (const r of resources) {
      const rid = id('res', r.id);
      if (r.parent) edge(`${id('res', r.parent)} --- ${rid}`);
      for (const ref of r.references) edge(`${rid} -->|uses| ${id('res', ref)}`);
      for (const w of r.waitsFor.filter((x) => !r.references.includes(x))) edge(`${rid} -.->|waits for| ${id('res', w)}`);
      for (const s of r.settings) edge(`${rid} -.-> ${id('res', s)}`);
    }
  }
  for (const r of model.resources) {
    if (r.project && nodeOfProject.has(r.project)) edge(`${id('res', r.id)} ==>|runs| ${nodeOfProject.get(r.project)}`);
  }

  // Project references, other than the AppHost's (drawn as "runs" above).
  for (const p of model.projects) {
    if (p.kind === 'apphost') continue;
    const from = nodeOfProject.get(p.name) ?? id('project', p.name);
    if (!nodeOfProject.has(p.name)) {
      nodeOfProject.set(p.name, from);
      lines.push(`  ${from}[${label(p.name, p.kind === 'app' ? 'application code' : '')}]`);
    }
    for (const ref of p.references) {
      if (!model.projects.some((x) => x.name === ref)) continue;
      const to = nodeOfProject.get(ref) ?? id(model.projects.find((x) => x.name === ref).kind === 'app' ? 'app' : 'project', ref);
      edge(p.kind === 'tests' ? `${from} -.->|tests| ${to}` : `${from} -.-> ${to}`);
    }
  }

  lines.push(...edges);
  if (red.length) lines.push(`  linkStyle ${red.join(',')} stroke:#dc2626,stroke-width:2px,color:#dc2626`);
  return { mermaid: `${lines.join('\n')}\n`, summary: summarize(model) };
}

function summarize(model) {
  return {
    projects: model.projects.length,
    resources: model.resources.length,
    areas: new Set(model.slices.map((s) => `${s.project}/${s.area}`)).size,
    slices: model.slices.length,
    sharedRules: model.domain.length,
    acceptanceTests: model.projects.filter((p) => p.testKind === 'acceptance').reduce((n, p) => n + p.tests, 0),
    crossSliceReferences: model.slices.reduce((n, s) => n + s.uses.slices.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Classes (/classes)
// ---------------------------------------------------------------------------

/**
 * The parts of the code a class diagram can show: each project, and in an app project each feature area, each
 * slice, Shared/Domain and Shared/Infrastructure. [{ id, label, project, kind, count }], the default first.
 */
export function classScopes(model) {
  const scopes = [];
  const order = { app: 0, servicedefaults: 1, apphost: 2, tests: 3 };
  const projects = [...model.projects].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  for (const p of projects) {
    const types = model.types.filter((t) => t.project === p.name);
    if (!types.length) continue;
    scopes.push({ id: `project:${p.name}`, label: `Everything in ${p.name}`, project: p.name, kind: 'project', count: types.length });
    if (p.kind !== 'app') continue;
    const slices = model.slices.filter((s) => s.project === p.name);
    for (const area of [...new Set(slices.map((s) => s.area))]) {
      const count = types.filter((t) => t.area === area && t.layer === 'slice').length;
      if (count) scopes.push({ id: `area:${p.name}/${area}`, label: `${area} (all slices)`, project: p.name, kind: 'area', count });
      for (const s of slices.filter((x) => x.area === area && x.types.length)) {
        scopes.push({ id: `slice:${s.key}`, label: `${area}/${s.name}`, project: p.name, kind: 'slice', count: s.types.length });
      }
    }
    for (const [layer, text] of [['domain', 'Shared/Domain'], ['infrastructure', 'Shared/Infrastructure']]) {
      const count = types.filter((t) => t.layer === layer).length;
      if (count) scopes.push({ id: `${layer}:${p.name}`, label: text, project: p.name, kind: layer, count });
    }
  }
  return scopes;
}

function typesInScope(model, scope) {
  const [kind, rest = ''] = scope.split(/:(.*)/s);
  const [project, area, slice] = rest.split('/');
  switch (kind) {
    case 'project':
      return model.types.filter((t) => t.project === rest);
    case 'area':
      return model.types.filter((t) => t.project === project && t.layer === 'slice' && t.area === area);
    case 'slice':
      return model.types.filter((t) => t.project === project && t.layer === 'slice' && t.area === area && t.slice === slice);
    case 'domain':
    case 'infrastructure':
      return model.types.filter((t) => t.project === rest && t.layer === kind);
    default:
      return null;
  }
}

const VISIBILITY = { public: '+', internal: '~', protected: '#', private: '-' };
const ANNOTATIONS = { interface: 'interface', enum: 'enumeration', record: 'record', 'record struct': 'record struct', struct: 'struct', delegate: 'delegate' };

function annotation(t) {
  if (ANNOTATIONS[t.kind]) return ANNOTATIONS[t.kind];
  if (t.modifiers.includes('static')) return 'static';
  if (t.modifiers.includes('abstract')) return 'abstract';
  return null;
}

function memberLines(t) {
  const out = [];
  const vis = (m) => VISIBILITY[m.visibility] ?? '+';
  const params = (list) => list.map((p) => `${p.type.text}${p.name ? ` ${p.name}` : ''}`).join(', ');
  const isRecord = t.kind === 'record' || t.kind === 'record struct';
  if (t.parameters && isRecord) {
    for (const p of t.parameters) out.push(`+${escapeMember(`${p.type.text} ${p.name}`)}`);
  } else if (t.parameters) {
    out.push(`+${escapeMember(t.name)}(${escapeMember(params(t.parameters))})`);
  }
  for (const m of t.members) {
    if (m.kind === 'value') out.push(escapeMember(m.name));
    else if (m.kind === 'field' || m.kind === 'property') out.push(`${vis(m)}${escapeMember(`${m.type.text} ${m.name}`)}${m.static ? '$' : ''}`);
    else if (m.kind === 'event') out.push(`${vis(m)}${escapeMember(`event ${m.type.text} ${m.name}`)}${m.static ? '$' : ''}`);
    else if (m.kind === 'indexer') out.push(`${vis(m)}${escapeMember(`this[${params(m.params)}] ${m.type.text}`)}`);
    else if (m.kind === 'constructor') out.push(`${vis(m)}${escapeMember(m.name)}(${escapeMember(params(m.params))})`);
    else if (m.kind === 'method') {
      const generic = m.typeParams.length ? `<${m.typeParams.join(', ')}>` : '';
      const flag = m.static ? '$' : m.abstract ? '*' : '';
      out.push(`${vis(m)}${escapeMember(m.name + generic)}(${escapeMember(params(m.params))})${flag} ${escapeMember(m.type.text)}`);
    }
  }
  return out;
}

const ARROWS = {
  inherits: (from, to) => `${to} <|-- ${from}`,
  implements: (from, to) => `${to} <|.. ${from}`,
  has: (from, to, many) => `${from} --> ${many ? '"*" ' : ''}${to}`,
  uses: (from, to) => `${from} ..> ${to}`,
};

/**
 * A class diagram of one scope from classScopes(). `members` shows fields, properties and methods; `related` also
 * draws, without their members, the types outside the scope that it uses or that use it (tests aside). Returns
 * { mermaid, scope, types, related }, or null for a scope that does not exist.
 */
export function classDiagram(model, { scope, members = true, related = true } = {}) {
  const chosen = typesInScope(model, scope ?? '');
  if (!chosen) return null;
  const byKey = new Map(model.types.map((t) => [t.key, t]));
  const inScope = new Set(chosen.map((t) => t.key));
  const extra = new Set();
  if (related) {
    for (const t of chosen) for (const r of t.relations) if (!inScope.has(r.to)) extra.add(r.to);
    const fromTests = chosen.some((t) => t.projectKind === 'tests');
    for (const t of model.types) {
      if (inScope.has(t.key) || (t.projectKind === 'tests' && !fromTests)) continue;
      if (t.relations.some((r) => inScope.has(r.to))) extra.add(t.key);
    }
  }
  const shown = [...chosen, ...[...extra].map((k) => byKey.get(k))].sort(
    (a, b) => a.namespace.localeCompare(b.namespace) || a.path.localeCompare(b.path),
  );

  const id = idMaker();
  const lines = ['classDiagram'];
  if (!shown.length) {
    lines.push(`  class empty["No types here yet"]`);
    return { mermaid: `${lines.join('\n')}\n`, scope, types: 0, related: 0 };
  }
  const namespaces = [...new Set(shown.map((t) => t.namespace))];
  for (const ns of namespaces) {
    const indent = ns ? '    ' : '  ';
    if (ns) lines.push(`  namespace ${ns} {`);
    for (const t of shown.filter((x) => x.namespace === ns)) {
      const name = t.path + (t.typeParams.length ? `<${t.typeParams.join(', ')}>` : '');
      const body = [];
      const note = annotation(t);
      if (note) body.push(`<<${note}>>`);
      if (members && inScope.has(t.key)) body.push(...memberLines(t));
      const head = `${indent}class ${id('c', t.key)}["${escapeLabel(name)}"]`;
      if (body.length) lines.push(`${head} {`, ...body.map((b) => `${indent}  ${b}`), `${indent}}`);
      else lines.push(head);
    }
    if (ns) lines.push('  }');
  }
  for (const t of shown) {
    for (const r of t.relations) {
      if (!inScope.has(t.key) && !inScope.has(r.to)) continue;
      if (!byKey.has(r.to) || !(inScope.has(r.to) || extra.has(r.to))) continue;
      lines.push(`  ${ARROWS[r.kind](id('c', t.key), id('c', r.to), r.many)}`);
    }
  }
  if (extra.size) lines.push(`  cssClass "${[...extra].map((k) => id('c', k)).join(',')}" related`);
  return { mermaid: `${lines.join('\n')}\n`, scope, types: chosen.length, related: extra.size };
}
