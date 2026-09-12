/**
 * Four-variable .env loader. A dependency would be more code than this.
 * Existing process env always wins, so CI and one-off overrides work.
 */
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(url = new URL('../../../.env', import.meta.url)) {
  if (!existsSync(url)) return;
  for (const line of readFileSync(url, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
