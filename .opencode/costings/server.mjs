#!/usr/bin/env node
// Token usage page for the /costings command: a small local server that reads .workflow/usage.db (it never
// writes it) and serves the page, its data and two CSV exports. Node 22.13+ built-ins only.
//
//   node .opencode/costings/server.mjs --open            foreground, Ctrl+C to stop
//   node .opencode/costings/server.mjs --open --detach   start in the background and return (used by /costings)
//   node .opencode/costings/server.mjs --csv summary|replies [--filter all|feature|bug|other]   CSV to stdout
//
// Options: --root <dir>  --port <n> (default 4330)  --open / --no-open  --detach  --idle-minutes <n> (0 = never)

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
import { FILTERS, readUsage, repliesCsv, summaryCsv } from './report.mjs';
import { NewerSchemaError, checkReadable, dbPath } from './schema.mjs';
import { loadSqlite } from './sqlite.mjs';

export const APP_ID = 'opencode-costings';
const SERVER_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(SERVER_FILE);
const INDEX_FILE = path.join(HERE, 'index.html');
const DEFAULT_PORT = 4330;
const NAME = 'Token usage page';
const CSV_KINDS = {
  summary: { file: 'usage-by-agent', build: summaryCsv },
  replies: { file: 'usage-replies', build: repliesCsv },
};
const ROUTES = ['/', '/index.html', '/api/health', '/api/usage', '/usage-by-agent.csv', '/usage-replies.csv', '/api/shutdown'];

const USAGE = `Usage: node server.mjs [--open | --no-open] [--detach] [--port <n>] [--root <dir>] [--idle-minutes <n>]
       node server.mjs --csv summary|replies [--filter all|feature|bug|other] [--root <dir>]

  --open            open the page in your browser
  --no-open         do not open the browser (overrides --open)
  --detach          start the page in the background, print its URL and exit
  --port <n>        port to listen on (default ${DEFAULT_PORT}; the next few are tried if it is taken)
  --root <dir>      project root (default: two folders above this file)
  --idle-minutes n  stop after n minutes without requests (default 15, 0 = never)
  --csv <kind>      write the summary or replies CSV to stdout and exit
  --filter <f>      with --csv: all (default), feature, bug or other`;

export function parseArgs(argv) {
  const opts = parseLauncherArgs(argv, {
    defaultRoot: path.resolve(HERE, '..', '..'),
    defaultPort: DEFAULT_PORT,
    valueFlags: { '--csv': 'csv', '--filter': 'filter' },
  });
  if (opts.csv !== undefined && !Object.hasOwn(CSV_KINDS, opts.csv)) throw new Error('--csv must be summary or replies');
  opts.filter ??= 'all';
  if (!FILTERS.includes(opts.filter)) throw new Error(`--filter must be one of: ${FILTERS.join(', ')}`);
  return opts;
}

/**
 * Run `read(db)` against the usage database, opened read-only for this one call; `db` is null when nothing has been
 * recorded yet. Problems become HttpErrors: 409 for a database from a newer template, 500 naming the file otherwise.
 */
export async function withUsageDb(root, read) {
  const file = dbPath(root);
  if (!existsSync(file)) return read(null);
  const DatabaseSync = await loadSqlite();
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw new HttpError(500, `Could not open ${file}: ${err.message}`);
  }
  try {
    return read(checkReadable(db) ? db : null);
  } catch (err) {
    if (err instanceof NewerSchemaError) throw new HttpError(409, err.message, { reason: 'newer-schema' });
    throw new HttpError(500, `Could not read ${file}: ${err.message}`);
  } finally {
    db.close();
  }
}

/**
 * Create (but do not start) the page server.
 * onShutdown defaults to stopping the process.
 */
export function createUsageServer({ root, idleMinutes = 15, onShutdown } = {}) {
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

  server.on('request', async (req, res) => {
    lastRequest = Date.now();
    try {
      const url = checkRequest(req, port);
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /':
        case 'GET /index.html': {
          const html = await readFile(INDEX_FILE);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': html.length,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
        case 'GET /api/usage':
          sendJson(res, 200, { root, generatedAt: new Date().toISOString(), ...(await withUsageDb(root, (db) => readUsage(db, root))) });
          return;
        case 'GET /usage-by-agent.csv':
        case 'GET /usage-replies.csv': {
          const filter = url.searchParams.get('filter') || 'all';
          if (!FILTERS.includes(filter)) throw new HttpError(400, `filter must be one of: ${FILTERS.join(', ')}`);
          const kind = url.pathname === '/usage-by-agent.csv' ? CSV_KINDS.summary : CSV_KINDS.replies;
          const body = Buffer.from(await withUsageDb(root, (db) => kind.build(db, root, filter)), 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Length': body.length,
            'Content-Disposition': `attachment; filename="${kind.file}${filter === 'all' ? '' : `-${filter}`}.csv"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(body);
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
    // In --detach mode stdout is what /costings shows, so report there.
    (opts.detach ? console.log : console.error)(`${NAME} could not start: no .opencode folder in ${opts.root}`);
    process.exit(1);
  }
  if (opts.csv) {
    try {
      process.stdout.write(await withUsageDb(opts.root, (db) => CSV_KINDS[opts.csv].build(db, opts.root, opts.filter)));
    } catch (err) {
      console.error(`Could not export the CSV: ${err.message}`);
      process.exit(1);
    }
    return;
  }
  const launch = {
    appId: APP_ID,
    name: NAME,
    root: opts.root,
    port: opts.port,
    idleMinutes: opts.idleMinutes,
    open: opts.open,
    runningLine: (url) => `${NAME} running at ${url}`,
  };
  if (opts.detach) await launchDetached({ ...launch, serverFile: SERVER_FILE });
  else {
    await runForeground({
      ...launch,
      strictPort: opts.strictPort,
      create: () => createUsageServer({ root: opts.root, idleMinutes: opts.idleMinutes }),
    });
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.log(`${NAME} could not start: ${err.message}`);
    process.exit(1);
  });
}
