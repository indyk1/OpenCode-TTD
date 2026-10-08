#!/usr/bin/env node
// The /diagram and /classes pages: a small local server that reads the project's C# code (it never changes it) and
// serves two diagrams drawn with Mermaid - the application's architecture and its classes - with their Mermaid text.
// Node 22 built-ins only.
//
//   node .opencode/diagrams/server.mjs --open                                  foreground, Ctrl+C to stop
//   node .opencode/diagrams/server.mjs --open --detach                         background, architecture (/diagram)
//   node .opencode/diagrams/server.mjs --page classes --open --detach          background, classes (/classes)
//   node .opencode/diagrams/server.mjs --mermaid architecture|classes [--scope <id>]   Mermaid text to stdout
//
// Options: --root <dir>  --port <n> (default 4340)  --open / --no-open  --detach  --idle-minutes <n> (0 = never)

import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HttpError,
  checkRequest,
  isEntryPoint,
  launchDetached,
  listenLocal,
  parseLauncherArgs,
  readJsonBody,
  runForeground,
  sendError,
  sendJson,
  startIdleTimer,
} from '../lib/local-web.mjs';
import { architectureDiagram, classDiagram, classScopes } from './mermaid.mjs';
import { readModel } from './model.mjs';

export const APP_ID = 'opencode-diagrams';
const SERVER_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(SERVER_FILE);
const INDEX_FILE = path.join(HERE, 'index.html');
const DEFAULT_PORT = 4340;
const NAME = 'Diagram page';
const PAGES = {
  architecture: { path: '', line: 'Architecture diagram running at' },
  classes: { path: '/classes', line: 'Class diagram running at' },
};
const ROUTES = ['/', '/index.html', '/classes', '/api/health', '/api/architecture', '/api/classes', '/architecture.mmd', '/classes.mmd', '/api/shutdown'];
// The page loads Mermaid (MIT) from jsDelivr, pinned and checked against its hash; see index.html.
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const USAGE = `Usage: node server.mjs [--page architecture|classes] [--open | --no-open] [--detach] [--port <n>] [--root <dir>] [--idle-minutes <n>]
       node server.mjs --mermaid architecture|classes [--scope <id>] [--root <dir>]

  --page <p>        the page to open: architecture (default, /diagram) or classes (/classes)
  --open            open the page in your browser
  --no-open         do not open the browser (overrides --open)
  --detach          start the page in the background, print its URL and exit
  --port <n>        port to listen on (default ${DEFAULT_PORT}; the next few are tried if it is taken)
  --root <dir>      project root (default: two folders above this file)
  --idle-minutes n  stop after n minutes without requests (default 15, 0 = never)
  --mermaid <d>     write the architecture or classes diagram's Mermaid text to stdout and exit
  --scope <id>      with --mermaid classes: the part of the code to draw, e.g. slice:Shop/Orders/CancelOrder`;

export function parseArgs(argv) {
  const opts = parseLauncherArgs(argv, {
    defaultRoot: path.resolve(HERE, '..', '..'),
    defaultPort: DEFAULT_PORT,
    valueFlags: { '--page': 'page', '--mermaid': 'mermaid', '--scope': 'scope' },
  });
  opts.page ??= 'architecture';
  if (!Object.hasOwn(PAGES, opts.page)) throw new Error('--page must be architecture or classes');
  if (opts.mermaid !== undefined && !Object.hasOwn(PAGES, opts.mermaid)) throw new Error('--mermaid must be architecture or classes');
  return opts;
}

function readProject(root) {
  try {
    return readModel(root);
  } catch (err) {
    throw new HttpError(500, `Could not read the code in ${root}: ${err.message}`);
  }
}

export function architecture(root) {
  const model = readProject(root);
  const { mermaid, summary } = architectureDiagram(model);
  return { root, generatedAt: new Date().toISOString(), empty: model.projects.length === 0, mermaid, summary, warnings: model.warnings };
}

/** The class diagram for `scope` (the first scope when it is missing or no longer exists). */
export function classes(root, { scope, members = true, related = true } = {}) {
  const model = readProject(root);
  const scopes = classScopes(model);
  const chosen = scopes.find((s) => s.id === scope) ?? scopes[0] ?? null;
  const diagram = chosen
    ? classDiagram(model, { scope: chosen.id, members, related })
    : { mermaid: 'classDiagram\n  class empty["No types yet"]\n', types: 0, related: 0 };
  return {
    root,
    generatedAt: new Date().toISOString(),
    empty: !chosen,
    scopes,
    scope: chosen?.id ?? null,
    requested: scope ?? null,
    members,
    related,
    mermaid: diagram.mermaid,
    types: diagram.types,
    relatedTypes: diagram.related,
    warnings: model.warnings,
  };
}

const flag = (value, fallback) => (value === null ? fallback : !['0', 'false', 'no', 'off'].includes(value.toLowerCase()));
const fileSafe = (text) => String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';

/**
 * Create (but do not start) the page server.
 * onShutdown defaults to stopping the process.
 */
export function createDiagramServer({ root, idleMinutes = 15, onShutdown } = {}) {
  let lastRequest = Date.now();
  let port = 0;
  const server = http.createServer();

  let stopIdleTimer = () => {};
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopIdleTimer();
    server.close(() => (onShutdown ? onShutdown() : process.exit(0)));
    server.closeAllConnections();
  };

  // Idle auto-shutdown; the page pings /api/health every 60s while it is open.
  stopIdleTimer = startIdleTimer(idleMinutes, () => lastRequest, shutdown);

  const sendMermaid = (res, text, file) => {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  };

  server.on('request', async (req, res) => {
    lastRequest = Date.now();
    try {
      const url = checkRequest(req, port);
      const route = `${req.method} ${url.pathname}`;
      const classOptions = () => ({
        scope: url.searchParams.get('scope') || undefined,
        members: flag(url.searchParams.get('members'), true),
        related: flag(url.searchParams.get('related'), true),
      });
      switch (route) {
        case 'GET /':
        case 'GET /index.html':
        case 'GET /classes': {
          const html = await readFile(INDEX_FILE);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': html.length,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': CSP,
          });
          res.end(html);
          return;
        }
        case 'GET /favicon.ico':
          res.writeHead(204).end();
          return;
        case 'GET /api/health':
          sendJson(res, 200, { app: APP_ID, root, port, pid: process.pid, idleMinutes });
          return;
        case 'GET /api/architecture':
          sendJson(res, 200, architecture(root));
          return;
        case 'GET /api/classes':
          sendJson(res, 200, classes(root, classOptions()));
          return;
        case 'GET /architecture.mmd':
          sendMermaid(res, architecture(root).mermaid, 'architecture.mmd');
          return;
        case 'GET /classes.mmd': {
          const result = classes(root, classOptions());
          sendMermaid(res, result.mermaid, `classes-${fileSafe(result.scope ?? 'none')}.mmd`);
          return;
        }
        case 'POST /api/shutdown':
          await readJsonBody(req).catch(() => {});
          res.once('finish', () => setImmediate(shutdown));
          sendJson(res, 200, { ok: true });
          return;
        default:
          if (ROUTES.includes(url.pathname)) throw new HttpError(405, 'Method not allowed');
          throw new HttpError(404, 'Not found');
      }
    } catch (err) {
      sendError(req, res, err);
    }
  });

  return {
    server,
    shutdown,
    get port() {
      return port;
    },
    async listen(p) {
      port = await listenLocal(server, p);
      return port;
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!existsSync(path.join(opts.root, '.opencode'))) {
    // In --detach mode stdout is what /diagram and /classes show, so report there.
    (opts.detach ? console.log : console.error)(`${NAME} could not start: no .opencode folder in ${opts.root}`);
    process.exit(1);
  }
  if (opts.mermaid) {
    try {
      const result = opts.mermaid === 'architecture' ? architecture(opts.root) : classes(opts.root, { scope: opts.scope });
      if (opts.scope && result.scope !== opts.scope) {
        console.error(`There is no scope ${opts.scope}. Scopes: ${result.scopes.map((s) => s.id).join(', ') || 'none'}`);
        process.exit(1);
      }
      process.stdout.write(result.mermaid);
    } catch (err) {
      console.error(`Could not draw the diagram: ${err.message}`);
      process.exit(1);
    }
    return;
  }
  const page = PAGES[opts.page];
  const launch = {
    appId: APP_ID,
    name: NAME,
    root: opts.root,
    port: opts.port,
    idleMinutes: opts.idleMinutes,
    open: opts.open,
    urlPath: page.path,
    runningLine: (url) => `${page.line} ${url}`,
  };
  if (opts.detach) await launchDetached({ ...launch, serverFile: SERVER_FILE });
  else {
    await runForeground({
      ...launch,
      strictPort: opts.strictPort,
      create: () => createDiagramServer({ root: opts.root, idleMinutes: opts.idleMinutes }),
    });
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.log(`${NAME} could not start: ${err.message}`);
    process.exit(1);
  });
}
