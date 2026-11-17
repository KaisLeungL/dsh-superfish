import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(root, '../..');
const runId = 'v1-0-0-' + randomUUID().slice(0, 8);

const b02Dir = resolve(repoRoot, '.superagent-product-lab/b02/runs', runId);
const b03Dir = resolve(repoRoot, '.superagent-product-lab/b03/runs', runId);
const b04Dir = resolve(repoRoot, '.superagent-product-lab/b04/runs', runId);
const e37Dir = resolve(repoRoot, '.superagent-product-lab/b03/runs', runId, 'e37');
const f84Dir = resolve(repoRoot, '.superagent-product-lab/b04-f8-product', runId);
for (const dir of [b02Dir, b03Dir, b04Dir, e37Dir, f84Dir]) {
  mkdirSync(dir, { recursive: true });
}

const suites = [
  'actions',
  'audit',
  'delegation',
  'f8',
  'genui',
  'health',
  'lifecycle',
  'personal',
  'projections',
  'prompts',
  'sessions',
  'storage',
  'task-board-read',
  'tools',
  'workspace-context',
];
const testFiles = [];
for (const suite of suites) {
  const dir = resolve(root, 'tests', suite);
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.test.ts')) {
      testFiles.push(resolve(dir, entry));
    }
  }
}

const loaderHook =
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){const[p,q]=s.split("?");if(p.endsWith(".js"))return n(p.slice(0,-3)+".ts"+(q?"?"+q:""),c);throw e}}';

const result = spawnSync(
  process.execPath,
  [
    '--experimental-transform-types',
    '--experimental-loader',
    loaderHook,
    '--test',
    ...testFiles,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      B02_RUN_DIR: b02Dir,
      B03_RUN_DIR: b03Dir,
      B04_RUN_DIR: b04Dir,
      E37_RUN_DIR: e37Dir,
      F84_TEST_ROOT: f84Dir,
    },
  },
);

process.exit(result.status ?? 1);
