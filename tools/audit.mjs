// Mechanical audit: every named import in the extension's JS files must exist
// as a named export in the resolved module (internal './'/'../' relative to
// src/, page-level '/...' resolved against the local SillyTavern reference
// clone at ../../.st-src/public). Auto-discovers index.js + src/*.js.
// Run: node tools/audit.mjs   (re-run after every refactor)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ST = resolve(ROOT, '..', '.st-src', 'public');
const files = ['index.js', ...readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.js')).map(f => `src/${f}`).sort()];

let failures = 0;
const exportCache = new Map();

function getExports(path) {
    if (exportCache.has(path)) return exportCache.get(path);
    const code = readFileSync(path, 'utf8');
    const names = new Set();
    const patterns = [
        /export\s+(?:async\s+)?function\s+(\w+)/g,
        /export\s+(?:async\s+)?const\s+(\w+)/g,
        /export\s+(?:async\s+)?let\s+(\w+)/g,
        /export\s+(?:async\s+)?var\s+(\w+)/g,
        /export\s+class\s+(\w+)/g,
        /export\s*\{([^}]+)\}/g,
    ];
    for (const re of patterns) {
        for (const m of code.matchAll(re)) {
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/).pop().trim();
                if (name) names.add(name);
            }
        }
    }
    exportCache.set(path, names);
    return names;
}

for (const rel of files) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) { console.log(`MISSING FILE: ${rel}`); failures++; continue; }
    const code = readFileSync(path, 'utf8');
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const spec = m[2];
        let target;
        if (spec.startsWith('.')) {
            target = resolve(dirname(path), spec);
        } else if (spec.startsWith('/')) {
            target = spec === '/script.js' ? join(ST, 'script.js') : join(ST, spec.replace(/^\//, ''));
        }
        if (!target || !existsSync(target)) { console.log(`${rel}: UNRESOLVED MODULE '${spec}'`); failures++; continue; }
        const exports = getExports(target);
        for (const raw of m[1].split(',')) {
            const name = raw.trim().split(/\s+as\s+/)[0].trim();
            if (!name) continue;
            if (!exports.has(name)) { console.log(`${rel}: MISSING EXPORT '${name}' in ${spec}`); failures++; }
        }
    }
}
console.log(`(scanned ${files.length} files against ${ST})`);
console.log(failures === 0 ? 'AUDIT CLEAN — all named imports resolve.' : `AUDIT FAILED — ${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
