import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePatch, applyPatch } from 'diff';
const here = dirname(fileURLToPath(import.meta.url));
// Peer dependencies can give pi-coding-agent its own pi-ai copy. Follow the
// installed Pi dependency graph so the model registry and the direct stream
// entry points receive the same verified patch, including packed installs.
const piPackages = new Set(['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent']);
const visited = new Set();
const roots = new Set();
function visit(root) {
 root = realpathSync(root);
 if (visited.has(root)) return;
 visited.add(root);
 const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
 if (pkg.name === '@earendil-works/pi-ai') roots.add(root);
 const require = createRequire(resolve(root, 'package.json'));
 for (const name of Object.keys(pkg.dependencies ?? {}).filter(name => piPackages.has(name))) {
  const parent = require.resolve.paths(name).find(path => existsSync(resolve(path, name, 'package.json')));
  if (!parent) throw new Error(`Usage patch dependency missing: ${name}`);
  visit(resolve(parent, name));
 }
}
visit(resolve(here, '../..'));
if (!roots.size) throw new Error('Usage patch found no pi-ai installation');
const manifest = JSON.parse(readFileSync(resolve(here, '../../patches/pi-ai-0.85.1.json'), 'utf8'));
const patches = parsePatch(readFileSync(resolve(here, '../../patches/pi-ai-0.85.1.patch'), 'utf8'));
const hash = (s) => createHash('sha256').update(s).digest('hex');
const writes = [];
for (const root of roots) {
 const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
 if (version !== manifest.version) throw new Error(`Usage patch requires pi-ai ${manifest.version}; found ${version}`);
 for (const entry of manifest.files) {
  const path = resolve(root, entry.path);
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (hash(old) === entry.after) continue;
  if (entry.before === null ? old !== '' : hash(old) !== entry.before) throw new Error(`Usage patch source mismatch: ${entry.path}`);
  const patch = patches.find(p => p.newFileName === entry.path);
  const next = applyPatch(old, patch);
  if (next === false || hash(next) !== entry.after) throw new Error(`Usage patch verification failed: ${entry.path}`);
  writes.push([path, next]);
 }
}
// Validate every source before writing any file. Re-running repairs an interrupted install.
for (const [path, content] of writes) writeFileSync(path, content);
console.log(`Verified pi-ai ${manifest.version} usage evidence patch (${roots.size} installations, ${writes.length} files applied)`);
