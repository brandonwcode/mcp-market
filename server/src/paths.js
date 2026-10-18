// Finds the project root (the folder with collection/collection.json) both when running from the repo
// and inside a serverless bundle, where files may be laid out relative to the task root instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function findRoot() {
  const candidates = [
    process.env.MCP_ROOT,
    path.resolve(HERE, '..', '..'),
    process.env.LAMBDA_TASK_ROOT,
    process.cwd(),
    '/var/task',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'collection', 'collection.json'))) return c;
  }
  throw new Error(`collection/collection.json not found (looked in ${candidates.join(', ')})`);
}
