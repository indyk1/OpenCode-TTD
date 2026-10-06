// Lets `node --test .opencode/lib/test/` work: Node 21+ runs a directory argument as a module, which
// resolves to this file; this file then imports the *.test.mjs files next to it.
// Written to load as either CommonJS or ESM, because there is deliberately no package.json here.
const entry = process.argv[1] || '';
if (!/index\.js$/.test(entry)) {
  (async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    for (const file of fs.readdirSync(entry).filter((f) => f.endsWith('.test.mjs')).sort()) {
      await import(url.pathToFileURL(path.join(entry, file)).href);
    }
  })();
}
