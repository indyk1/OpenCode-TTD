// Reads a project for the /diagram and /classes pages: its .NET projects, the types in their C# files and how the
// types relate, the vertical slices with their routes and tests, the shared code, and the resources the Aspire
// AppHost runs. Everything is computed from the files on each call, so it is always current. Node built-ins only.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseCSharp } from './csharp.mjs';

/** Folders never searched for projects or code. */
const SKIP_DIRS = new Set(['.git', '.opencode', '.workflow', '.vs', '.vscode', '.idea', 'node_modules', 'bin', 'obj', 'TestResults', 'openspec']);
const MAX_DEPTH = 8;
const TEST_ATTRIBUTES = new Set(['Test', 'TestCase', 'TestCaseSource', 'Theory', 'Fact', 'TestMethod', 'DataTestMethod']);
const TEST_PACKAGES = /^(NUnit|xunit|xunit\.v3|MSTest|MSTest\.TestFramework|Microsoft\.NET\.Test\.Sdk|TUnit)$/i;

/** How an AppHost resource is drawn, by the name of its Add method. */
const RESOURCE_KINDS = {
  Project: ['app', 'project'],
  Container: ['app', 'container'],
  Executable: ['app', 'program'],
  NpmApp: ['app', 'JavaScript app'],
  JavaScriptApp: ['app', 'JavaScript app'],
  ViteApp: ['app', 'Vite app'],
  PythonApp: ['app', 'Python app'],
  Postgres: ['data', 'PostgreSQL'],
  SqlServer: ['data', 'SQL Server'],
  MySql: ['data', 'MySQL'],
  Oracle: ['data', 'Oracle'],
  MongoDB: ['data', 'MongoDB'],
  Sqlite: ['data', 'SQLite'],
  Database: ['data', 'database'],
  AzureCosmosDB: ['data', 'Azure Cosmos DB'],
  AzureSqlServer: ['data', 'Azure SQL'],
  AzurePostgresFlexibleServer: ['data', 'Azure PostgreSQL'],
  AzureStorage: ['data', 'Azure Storage'],
  Blobs: ['data', 'blob storage'],
  Queues: ['queue', 'storage queues'],
  Tables: ['data', 'table storage'],
  Redis: ['data', 'Redis cache'],
  Valkey: ['data', 'Valkey cache'],
  Garnet: ['data', 'Garnet cache'],
  RabbitMQ: ['queue', 'RabbitMQ'],
  Kafka: ['queue', 'Kafka'],
  Nats: ['queue', 'NATS'],
  AzureServiceBus: ['queue', 'Azure Service Bus'],
  Parameter: ['setting', 'setting'],
  ConnectionString: ['setting', 'connection string'],
  AzureContainerAppEnvironment: ['deploy', 'Azure Container Apps'],
  AzureAppServiceEnvironment: ['deploy', 'Azure App Service'],
  DockerComposeEnvironment: ['deploy', 'Docker Compose'],
  KubernetesEnvironment: ['deploy', 'Kubernetes'],
};

const posix = (p) => p.split(path.sep).join('/');
const fullName = (t) => (t.namespace ? `${t.namespace}.${t.path}` : t.path);

/**
 * Read the project at `root`. Returns
 *   { root, projects, types, slices, domain, infrastructure, resources, warnings }
 * - projects: [{ name, dir, kind: 'app' | 'apphost' | 'servicedefaults' | 'tests', testKind, references, packages, files,
 *   tests }] - `tests` is the number of test methods in it
 * - types: [{ key, name, path, namespace, kind, typeParams, visibility, modifiers, doc, project, file, line, area,
 *   slice, layer: 'slice' | 'domain' | 'infrastructure' | 'other', group, members, parameters,
 *   relations: [{ kind: 'inherits' | 'implements' | 'has' | 'uses', to, many }] }] - `to` is another type's key
 * - slices: [{ key, project, area, name, dir, route, method, types, uses: { domain, infrastructure, slices },
 *   tests: { acceptance, unit, other } }]
 * - domain: the keys of the Shared/Domain types; infrastructure: Shared/Infrastructure grouped by sub-folder: [{ project, group, types }]
 * - resources: what the AppHost runs: [{ id, name, method, kind, shape, label, parent, project, secret, references,
 *   waitsFor, settings }]
 */
export function readModel(root) {
  const warnings = [];
  const projects = findProjects(root, warnings);
  const parsed = [];
  for (const project of projects) {
    for (const file of project.files) {
      const abs = path.join(root, file);
      let source;
      try {
        source = readFileSync(abs, 'utf8');
      } catch (err) {
        warnings.push(`Could not read ${file}: ${err.message}`);
        continue;
      }
      try {
        parsed.push({ project, file, source, result: parseCSharp(source) });
      } catch (err) {
        warnings.push(`Could not read the code in ${file}: ${err.message}`);
      }
    }
  }

  const types = mergeTypes(parsed);
  const resolve = makeResolver(types, parsed);
  relate(types, resolve);
  const slices = findSlices(root, projects, types, parsed);
  countTests(projects, types, slices, resolve);
  const domain = types.filter((t) => t.layer === 'domain').map((t) => t.key);
  const infrastructure = groupInfrastructure(types);
  const resources = readResources(projects, parsed);
  for (const t of types) delete t.contexts;
  return { root, projects, types, slices, domain, infrastructure, resources, warnings };
}

// ---------------------------------------------------------------------------
// Projects and files
// ---------------------------------------------------------------------------

function findProjects(root, warnings) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.csproj')) found.push(path.join(dir, e.name));
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  found.sort();

  const projectDirs = new Set(found.map((f) => path.dirname(f)));
  const projects = [];
  for (const file of found) {
    let xml;
    try {
      xml = readFileSync(file, 'utf8');
    } catch (err) {
      warnings.push(`Could not read ${posix(path.relative(root, file))}: ${err.message}`);
      continue;
    }
    const dir = path.dirname(file);
    const name = path.basename(file, '.csproj');
    const packages = [...xml.matchAll(/<PackageReference\b[^>]*?\bInclude="([^"]+)"(?:[^>]*?\bVersion="([^"]*)")?/g)].map((m) => ({
      name: m[1],
      version: m[2] ?? '',
    }));
    const references = [...xml.matchAll(/<ProjectReference\b[^>]*?\bInclude="([^"]+)"/g)].map((m) =>
      path.basename(m[1].replace(/\\/g, '/'), '.csproj'),
    );
    const isAppHost = /Aspire\.AppHost\.Sdk/i.test(xml) || /<IsAspireHost>\s*true\s*</i.test(xml);
    const isServiceDefaults = /<IsAspireSharedProject>\s*true\s*</i.test(xml) || /\.ServiceDefaults$/.test(name);
    const isTests = /<IsTestProject>\s*true\s*</i.test(xml) || packages.some((p) => TEST_PACKAGES.test(p.name)) || /Tests?$/.test(name);
    const kind = isAppHost ? 'apphost' : isServiceDefaults ? 'servicedefaults' : isTests ? 'tests' : 'app';
    const testKind = kind !== 'tests' ? null : /Acceptance/i.test(name) ? 'acceptance' : /Unit/i.test(name) ? 'unit' : /Architecture/i.test(name) ? 'architecture' : 'other';
    const files = [];
    const collect = (d, depth) => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isFile() && e.name.endsWith('.cs')) files.push(posix(path.relative(root, p)));
        else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && depth < MAX_DEPTH && !projectDirs.has(p)) {
          collect(p, depth + 1);
        }
      }
    };
    collect(dir, 0);
    files.sort();
    projects.push({ name, dir: posix(path.relative(root, dir)) || '.', kind, testKind, references, packages, files, tests: 0 });
  }
  return projects;
}

/** Where a file sits in an app project: a slice, Shared/Domain, a Shared/Infrastructure group, or elsewhere. */
function locate(project, file) {
  const rel = project.dir === '.' ? file : file.slice(project.dir.length + 1);
  if (project.kind !== 'app') return { layer: 'other' };
  let m = /^Features\/([^/]+)\/([^/]+)\//.exec(rel);
  if (m) return { layer: 'slice', area: m[1], slice: m[2] };
  if (/^Shared\/Domain\//.test(rel)) return { layer: 'domain' };
  m = /^Shared\/Infrastructure\/(?:([^/]+)\/)?/.exec(rel);
  if (m) return { layer: 'infrastructure', group: m[1] ?? '' };
  return { layer: 'other' };
}

// ---------------------------------------------------------------------------
// Types and how they relate
// ---------------------------------------------------------------------------

/** One entry per type, partial declarations merged. */
function mergeTypes(parsed) {
  const byKey = new Map();
  for (const { project, file, result } of parsed) {
    const where = locate(project, file);
    for (const t of result.types) {
      const key = `${fullName(t)}${t.typeParams.length ? `\`${t.typeParams.length}` : ''}`;
      const context = { usings: result.usings, aliases: result.aliases };
      const existing = byKey.get(key);
      if (existing) {
        existing.members.push(...t.members);
        existing.bases.push(...t.bases.filter((b) => !existing.bases.some((e) => e.text === b.text)));
        existing.refs.push(...t.refs);
        existing.contexts.push(context);
        existing.doc ||= t.doc;
        existing.parameters ??= t.parameters;
        continue;
      }
      byKey.set(key, {
        key,
        name: t.name,
        path: t.path,
        parentPath: t.parent,
        namespace: t.namespace,
        kind: t.kind,
        typeParams: t.typeParams,
        visibility: t.visibility,
        modifiers: t.modifiers,
        attributes: t.attributes,
        doc: t.doc,
        project: project.name,
        projectKind: project.kind,
        testKind: project.testKind,
        file,
        line: t.line,
        layer: where.layer,
        area: where.area ?? null,
        slice: where.slice ?? null,
        group: where.group ?? null,
        bases: [...t.bases],
        parameters: t.parameters,
        members: [...t.members],
        refs: [...t.refs],
        contexts: [context],
        relations: [],
      });
    }
  }
  return [...byKey.values()];
}

/** Resolves type names as the C# compiler would, near enough for a diagram. */
function makeResolver(types, parsed) {
  const byFull = new Map();
  const bySimple = new Map();
  for (const t of types) {
    const full = fullName(t);
    if (!byFull.has(full)) byFull.set(full, t);
    if (!bySimple.has(t.name)) bySimple.set(t.name, []);
    bySimple.get(t.name).push(t);
  }
  const globalUsings = new Map(); // project -> namespaces
  for (const { project, result } of parsed) {
    if (!globalUsings.has(project.name)) globalUsings.set(project.name, new Set());
    for (const u of result.globalUsings) globalUsings.get(project.name).add(u);
  }

  const exact = (name, from) => {
    if (!name) return null;
    let n = name;
    const first = n.split('.')[0];
    for (const ctx of from.contexts) {
      if (Object.hasOwn(ctx.aliases, first)) {
        n = ctx.aliases[first] + n.slice(first.length);
        break;
      }
    }
    // Nested in this type or the types around it.
    const outer = (t) => (t.parentPath ? byFull.get(t.namespace ? `${t.namespace}.${t.parentPath}` : t.parentPath) : null);
    for (let p = from; p; p = outer(p)) {
      const hit = byFull.get(`${fullName(p)}.${n}`);
      if (hit) return hit;
    }
    // This namespace and the ones around it, then the global namespace.
    for (let ns = from.namespace; ; ns = ns.slice(0, Math.max(0, ns.lastIndexOf('.')))) {
      const hit = byFull.get(ns ? `${ns}.${n}` : n);
      if (hit) return hit;
      if (!ns) break;
    }
    // using directives.
    const usings = new Set(from.contexts.flatMap((c) => c.usings));
    for (const u of globalUsings.get(from.project) ?? []) usings.add(u);
    for (const u of usings) {
      const hit = byFull.get(`${u}.${n}`);
      if (hit) return hit;
    }
    // A name only one type has.
    const last = n.split('.').pop();
    const candidates = (bySimple.get(last) ?? []).filter((t) => fullName(t) === n || fullName(t).endsWith(`.${n}`));
    return candidates.length === 1 ? candidates[0] : null;
  };

  return {
    exact,
    /** A dotted name from a body (Policy.CanCancel, Contracts.Response): the longest start of it that is a type. */
    chain(name, from) {
      const parts = name.split('.');
      for (let k = parts.length; k > 0; k--) {
        const hit = exact(parts.slice(0, k).join('.'), from);
        if (hit) return hit;
      }
      return null;
    },
  };
}

function relate(types, resolve) {
  for (const t of types) {
    const rel = new Map(); // to.key -> relation
    const add = (kind, to, many = false) => {
      if (!to || to === t) return;
      const rank = { inherits: 4, implements: 3, has: 2, uses: 1 };
      const existing = rel.get(to.key);
      if (!existing || rank[kind] > rank[existing.kind]) rel.set(to.key, { kind, to: to.key, many: many || Boolean(existing?.many) });
      else if (existing.kind === kind && many) existing.many = true;
    };
    t.bases.forEach((base) => {
      const target = resolve.exact(base.name, t);
      if (target) add(target.kind === 'interface' ? 'implements' : 'inherits', target);
      for (const r of base.refs.slice(1)) add('uses', resolve.exact(r.name, t));
    });
    const typeRefs = (ref, kind) => ref && ref.refs.forEach((r) => add(kind, resolve.exact(r.name, t), r.many));
    const isRecord = t.kind === 'record' || t.kind === 'record struct';
    for (const p of t.parameters ?? []) typeRefs(p.type, isRecord ? 'has' : 'uses');
    for (const m of t.members) {
      const held = m.kind === 'field' || m.kind === 'property' || m.kind === 'event';
      typeRefs(m.type, held ? 'has' : 'uses');
      for (const p of m.params) typeRefs(p.type, 'uses');
      for (const name of m.refs) add('uses', resolve.chain(name, t));
    }
    for (const name of t.refs) add('uses', resolve.chain(name, t));
    t.relations = [...rel.values()];
  }
}

// ---------------------------------------------------------------------------
// Slices, shared code and tests
// ---------------------------------------------------------------------------

function findSlices(root, projects, types, parsed) {
  const slices = [];
  const sources = new Map(parsed.map((p) => [p.file, p.source]));
  for (const project of projects.filter((p) => p.kind === 'app')) {
    const features = path.join(root, project.dir, 'Features');
    for (const area of listDirs(features)) {
      for (const name of listDirs(path.join(features, area))) {
        const dir = `${project.dir === '.' ? '' : `${project.dir}/`}Features/${area}/${name}`;
        const files = project.files.filter((f) => f.startsWith(`${dir}/`));
        let route = null;
        let method = null;
        for (const f of files) {
          const source = sources.get(f) ?? '';
          if (f.endsWith('.Contracts.cs') && route === null) {
            const m = /const\s+string\s+Route\s*=\s*@?"([^"]*)"/.exec(source);
            if (m) route = m[1];
          }
          if (!f.endsWith('.Contracts.cs') && method === null) {
            const m = /\.Map(Get|Post|Put|Patch|Delete)\s*[(<]/.exec(source);
            if (m) method = m[1].toUpperCase();
          }
        }
        slices.push({
          key: `${project.name}/${area}/${name}`,
          project: project.name,
          area,
          name,
          dir,
          route,
          method,
          types: types.filter((t) => t.project === project.name && t.area === area && t.slice === name).map((t) => t.key),
          uses: { domain: [], infrastructure: [], slices: [] },
          tests: { acceptance: 0, unit: 0, other: 0 },
        });
      }
    }
  }

  const byKey = new Map(types.map((t) => [t.key, t]));
  for (const s of slices) {
    const domain = new Set();
    const infrastructure = new Set();
    const others = new Set();
    for (const key of s.types) {
      for (const r of byKey.get(key).relations) {
        const to = byKey.get(r.to);
        if (to.project !== s.project) continue;
        if (to.layer === 'domain') domain.add(to.key);
        else if (to.layer === 'infrastructure' && r.kind !== 'implements' && r.kind !== 'inherits') infrastructure.add(to.group);
        else if (to.layer === 'slice' && (to.area !== s.area || to.slice !== s.name)) others.add(`${to.project}/${to.area}/${to.slice}`);
      }
    }
    s.uses = { domain: [...domain].sort(), infrastructure: [...infrastructure].sort(), slices: [...others].sort() };
  }
  return slices;
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** A test method belongs to the slices whose types it uses (in its signature or body, or else in its class). */
function countTests(projects, types, slices, resolve) {
  const byProject = new Map(projects.map((p) => [p.name, p]));
  const sliceOf = (t) => (t && t.layer === 'slice' ? `${t.project}/${t.area}/${t.slice}` : null);
  const bySlice = new Map(slices.map((s) => [s.key, s]));
  for (const t of types.filter((x) => x.projectKind === 'tests')) {
    const testKind = t.testKind === 'acceptance' || t.testKind === 'unit' ? t.testKind : 'other';
    const targets = (names, refs) => {
      const hits = new Set();
      for (const n of names) hits.add(sliceOf(resolve.chain(n, t)));
      for (const r of refs) hits.add(sliceOf(resolve.exact(r.name, t)));
      hits.delete(null);
      return hits;
    };
    const classLevel = targets(
      [...t.refs, ...t.members.filter((m) => m.kind !== 'method').flatMap((m) => m.refs)],
      t.members.filter((m) => m.kind !== 'method').flatMap((m) => m.type?.refs ?? []),
    );
    for (const m of t.members) {
      if (m.kind !== 'method' || !m.attributes.some((a) => TEST_ATTRIBUTES.has(a.name))) continue;
      byProject.get(t.project).tests++;
      let hits = targets(m.refs, [...(m.type?.refs ?? []), ...m.params.flatMap((p) => p.type.refs)]);
      if (!hits.size) hits = classLevel;
      for (const key of hits) bySlice.get(key).tests[testKind]++;
    }
  }
}

function groupInfrastructure(types) {
  const groups = new Map();
  for (const t of types.filter((x) => x.layer === 'infrastructure')) {
    const key = `${t.project}/${t.group}`;
    if (!groups.has(key)) groups.set(key, { project: t.project, group: t.group, types: [] });
    groups.get(key).types.push(t.key);
  }
  return [...groups.values()].sort((a, b) => a.project.localeCompare(b.project) || a.group.localeCompare(b.group));
}

// ---------------------------------------------------------------------------
// AppHost resources
// ---------------------------------------------------------------------------

const isP = (t, v) => t !== undefined && t.k === 'p' && t.v === v;

function closingIndex(tokens, start, open, close) {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    if (isP(tokens[j], open)) depth++;
    else if (isP(tokens[j], close) && --depth === 0) return j;
  }
  return tokens.length;
}

/** The resources each AppHost adds - `builder.AddPostgres("pg")`, `pg.AddDatabase("db")`, `.WithReference(db)` … */
function readResources(projects, parsed) {
  const resources = [];
  const byName = new Map();
  for (const { project, result } of parsed) {
    if (project.kind !== 'apphost') continue;
    const builders = new Set(['builder']);
    const vars = new Map();
    for (const tokens of result.statements) {
      let j = 0;
      let assigned = null;
      if (tokens[0]?.k === 'id' && tokens[0].v === 'var' && tokens[1]?.k === 'id' && isP(tokens[2], '=')) {
        assigned = tokens[1].v;
        j = 3;
      }
      if (tokens[j]?.k !== 'id') continue;
      if (tokens[j].v === 'DistributedApplication') {
        if (assigned) builders.add(assigned);
        continue;
      }
      let current = vars.get(tokens[j].v) ?? null;
      if (!current && !builders.has(tokens[j].v)) continue;
      j++;
      while (isP(tokens[j], '.') && tokens[j + 1]?.k === 'id') {
        const method = tokens[j + 1].v;
        j += 2;
        let typeArg = null;
        if (isP(tokens[j], '<')) {
          const end = closingIndex(tokens, j, '<', '>');
          typeArg = tokens.slice(j + 1, end).map((t) => t.v).join('');
          j = end + 1;
        }
        if (!isP(tokens[j], '(')) break;
        const end = closingIndex(tokens, j, '(', ')');
        const args = tokens.slice(j + 1, end);
        j = end + 1;
        if (/^Add[A-Z]/.test(method) && args[0]?.k === 'str') {
          const kind = method.slice(3);
          const [shape, label] = RESOURCE_KINDS[kind] ?? [/Environment$/.test(kind) ? 'deploy' : 'other', words(kind)];
          const resource = {
            id: `${project.name}/${args[0].v}`,
            name: args[0].v,
            host: project.name,
            method,
            kind,
            shape,
            label,
            parent: current?.id ?? null,
            project: typeArg?.startsWith('Projects.') ? projectNamed(projects, typeArg.slice('Projects.'.length)) : null,
            secret: kind === 'Parameter' && isSecret(args),
            references: [],
            waitsFor: [],
            settings: [],
          };
          if (!byName.has(resource.id)) {
            byName.set(resource.id, resource);
            resources.push(resource);
          }
          current = byName.get(resource.id);
        } else if (current) {
          for (const a of args) {
            const target = a.k === 'id' ? vars.get(a.v) : null;
            if (!target || target === current) continue;
            const list = /^WithReference$/.test(method) ? current.references : /^WaitFor/.test(method) ? current.waitsFor : current.settings;
            if (!list.includes(target.id)) list.push(target.id);
          }
        }
      }
      if (assigned && current) vars.set(assigned, current);
    }
  }
  return resources;
}

function isSecret(args) {
  for (let k = 0; k < args.length; k++) {
    if (args[k].k === 'id' && args[k].v === 'secret' && isP(args[k + 1], ':') && args[k + 2]?.v === 'true') return true;
  }
  return args.length >= 3 && isP(args[1], ',') && args[2]?.k === 'id' && args[2].v === 'true';
}

/** `Projects.Acme_Orders` names the project Acme.Orders: Aspire turns dots and dashes into underscores. */
function projectNamed(projects, generated) {
  const hit = projects.find((p) => p.name.replace(/[^A-Za-z0-9_]/g, '_') === generated);
  return hit ? hit.name : generated;
}

const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
