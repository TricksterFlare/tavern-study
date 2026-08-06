import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const configHome = resolve('.tmp-wrangler-config');
mkdirSync(configHome, { recursive: true });
const cli = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: configHome }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
