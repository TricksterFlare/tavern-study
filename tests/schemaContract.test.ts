import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const wrangler = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');

function runWrangler(args: string[], persistTo: string, configHome: string) {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--local', '--config', 'wrangler.test.toml', '--persist-to', persistTo], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('schema init and first migration remain identical and install on empty D1 databases', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-study-schema-'));
  try {
    const [init, migration] = await Promise.all([
      readFile('examples/cloudflare/schema/init.sql', 'utf8'),
      readFile('examples/cloudflare/schema/migrations/0001_initial.sql', 'utf8'),
    ]);
    assert.equal(init.replaceAll('\r\n', '\n'), migration.replaceAll('\r\n', '\n'));

    runWrangler(['d1', 'execute', 'OC_DB', '--file', 'examples/cloudflare/schema/init.sql'], join(root, 'init'), join(root, 'config-init'));
    runWrangler(['d1', 'migrations', 'apply', 'OC_DB'], join(root, 'migration'), join(root, 'config-migration'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
