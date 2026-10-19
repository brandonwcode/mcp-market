// Scheduled entry (Netlify scheduled function, see netlify.toml): every few minutes, keep the Helius webhook
// in sync and credit any deposit the webhook missed. Safe to run any number of times.
import { openPg } from './pg.js';
import { migrate } from './schema.js';
import { createDeposits } from './deposits.js';

export function createCronHandler(opts = {}) {
  let ready = null;
  const init = async () => {
    const db = opts.db || openPg(process.env.DATABASE_URL, { max: 2 });
    await migrate(db);
    return opts.deposits || createDeposits(db, { publicUrl: opts.publicUrl, rpc: opts.rpc, helius: opts.helius, config: opts.depositConfig });
  };
  return async (event, context) => {
    if (context) context.callbackWaitsForEmptyEventLoop = false;
    ready ??= init().catch((e) => { ready = null; throw e; });
    const deposits = await ready;
    const out = deposits.enabled ? await deposits.tick({ budgetMs: opts.budgetMs ?? 20_000 }) : { skipped: deposits.problem };
    console.log('deposits tick', JSON.stringify(out));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  };
}
