import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const file of readdirSync(resolve(root, 'lib')).filter(file => file.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', resolve(root, 'lib', file)], { stdio: 'pipe' });
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const report = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' }));
// npm 10/11 return an array; npm 12 keys reports by package name.
const packed = Array.isArray(report) ? report[0] : report[pkg.name] ?? report;
const paths = new Set(packed.files.map(file => file.path));
for (const path of ['package.json', 'cordis.patch.yml', 'data/prices.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  ...Object.values(pkg.exports).map(path => path.replace(/^\.\//, ''))]) {
  assert(paths.has(path), 'Missing install file: ' + path);
}
const patch = readFileSync(resolve(root, pkg.dsh.bundle.patch), 'utf8');
assert(patch.includes('name: ' + pkg.name), 'Bundle patch must register this package');
const client = readFileSync(resolve(root, pkg.exports['./client']), 'utf8');
assert(client.includes("id: '" + pkg.name + "'"), 'Client factory must match the package name');
const prices = JSON.parse(readFileSync(resolve(root, 'data/prices.json'), 'utf8'));
assert.equal(prices.version, 1);
assert(Object.keys(prices.routes).length > 0 && Object.keys(prices.deepseek.rates).length > 0, 'Missing offline prices');
for (const path of paths) {
  assert(!/^(?:test|scripts|node_modules|\.github|work|outputs)\//.test(path), 'Unexpected publish file: ' + path);
  assert(!/(?:\.env(?:\.|$)|auth\.json|cookies|session-.*\.json)/i.test(path), 'Unexpected local data in package: ' + path);
}
for (const path of ['README.md', 'docs/INSTALL.md', 'docs/TESTING.md']) {
  const content = readFileSync(resolve(root, path), 'utf8');
  for (const [, link] of content.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|#)/.test(link)) continue;
    const target = resolve(root, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', link.split('#')[0]);
    assert(existsSync(target), 'Broken local documentation link in ' + path + ': ' + link);
  }
}
console.log(`Checked ${pkg.name}@${pkg.version}: ${paths.size} package files, native entries and documentation links valid.`);
