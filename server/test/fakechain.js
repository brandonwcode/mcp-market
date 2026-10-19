// A tiny in-memory Solana for tests: the two RPC methods the deposit code uses, plus the Helius webhook API.
// Transactions are shaped like real getTransaction (encoding json) results.
import crypto from 'node:crypto';
import { base58 } from '@scure/base';
import { TOKEN_PROGRAM, seedFromMnemonic } from '../src/solana.js';
import { makePoolRows, poolKeyFromSeed } from '../src/pool.js';

export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const FAKE_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // mainnet USDT mint, used here as a devnet test token

export const TEST_SEED = seedFromMnemonic(TEST_MNEMONIC);
export const TEST_POOL_KEY = poolKeyFromSeed(TEST_SEED);

export const randomAddress = () => base58.encode(crypto.randomBytes(32));

// what the owner does once: make addresses offline and import the CSV into deposit_pool
export async function seedPool(db, { network = 'devnet', start = 0, count = 20, seed = TEST_SEED } = {}) {
  const { rows } = makePoolRows(seed, network, start, count);
  for (const r of rows) {
    await db.query('insert into deposit_pool (network, idx, address, mac) values ($1, $2, $3, $4)', [r.network, r.idx, r.address, r.mac]);
  }
  return rows;
}
const randomSig = () => base58.encode(crypto.randomBytes(64));

// deposit settings for tests: devnet, USDC + USDT, no throttling between checks
export const testDepositConfig = (over = {}) => ({
  testMode: true,
  cluster: 'devnet',
  tokens: [{ symbol: 'USDC', mint: DEV_USDC }, { symbol: 'USDT', mint: FAKE_USDT }],
  poolKey: TEST_POOL_KEY,
  heliusKey: 'test',
  rpcUrl: 'http://fake-rpc.invalid',
  webhookSecret: '',
  minDeposit: 10_000, // $0.01
  recheckMs: 0,
  ...over,
});

export function fakeChain() {
  const sigsByAddr = new Map(); // address -> newest first
  const txs = new Map();
  const hidden = new Set(); // signatures getTransaction can't see yet (a lagging node)
  const calls = [];
  let slot = 1000;

  function addTx({ accountKeys, loaded = { writable: [], readonly: [] }, pre = [], post = [], err = null }) {
    const signature = randomSig();
    slot += 1;
    const tx = {
      slot, blockTime: Math.floor(Date.now() / 1000), version: 0,
      meta: { err, fee: 5000, preTokenBalances: pre, postTokenBalances: post, loadedAddresses: loaded },
      transaction: { signatures: [signature], message: { accountKeys } },
    };
    txs.set(signature, tx);
    for (const a of new Set([...accountKeys, ...loaded.writable, ...loaded.readonly])) {
      if (!sigsByAddr.has(a)) sigsByAddr.set(a, []);
      sigsByAddr.get(a).unshift({ signature, slot, err, blockTime: tx.blockTime, confirmationStatus: 'confirmed' });
    }
    return signature;
  }

  // A token transfer into `to` (a token account owned by `owner`). amount is raw (6 decimals = micro-dollars).
  // inLookupTable puts the receiving account in the v0 address lookup table part of the transaction.
  function transfer({ mint, to, owner, amount, before = 0, decimals = 6, err = null, inLookupTable = false, ownerInPost }) {
    const sender = randomAddress();
    const senderAta = randomAddress();
    const keys = [sender, senderAta, ...(inLookupTable ? [] : [to]), mint, TOKEN_PROGRAM];
    const loaded = { writable: inLookupTable ? [to] : [], readonly: [] };
    const toIndex = inLookupTable ? keys.length : 2;
    const bal = (accountIndex, own, amt) => ({ accountIndex, mint, owner: own, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: String(amt), decimals } });
    const pre = [bal(1, sender, 10n ** 15n), ...(before != null ? [bal(toIndex, owner, before)] : [])];
    const post = [bal(1, sender, 10n ** 15n - BigInt(amount)), bal(toIndex, ownerInPost ?? owner, BigInt(before ?? 0) + BigInt(amount))];
    return addTx({ accountKeys: keys, loaded, pre, post, err });
  }

  // one transaction paying several of our token accounts at once (an exchange batch payout)
  function batch(mint, payments) {
    const sender = randomAddress();
    const senderAta = randomAddress();
    const keys = [sender, senderAta, ...payments.map((p) => p.to), mint, TOKEN_PROGRAM];
    const total = payments.reduce((s, p) => s + BigInt(p.amount), 0n);
    const bal = (accountIndex, own, amt) => ({ accountIndex, mint, owner: own, uiTokenAmount: { amount: String(amt), decimals: 6 } });
    return addTx({
      accountKeys: keys,
      pre: [bal(1, sender, 10n ** 15n)],
      post: [bal(1, sender, 10n ** 15n - total), ...payments.map((p, i) => bal(2 + i, p.owner, p.amount))],
    });
  }

  // what a Helius "raw" webhook delivers for one transaction
  const webhookItem = (signature) => structuredClone(txs.get(signature));

  async function rpc(method, params) {
    calls.push(method);
    if (method === 'getSignaturesForAddress') {
      const [addr, { limit = 1000, until, before } = {}] = params;
      let list = sigsByAddr.get(addr) || [];
      if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1);
      if (until) {
        const i = list.findIndex((s) => s.signature === until);
        if (i >= 0) list = list.slice(0, i);
      }
      return list.slice(0, limit).map((s) => ({ ...s }));
    }
    if (method === 'getTransaction') {
      const [sig] = params;
      if (hidden.has(sig) || !txs.has(sig)) return null;
      return structuredClone(txs.get(sig));
    }
    throw new Error(`fake chain: unexpected ${method}`);
  }

  // Helius webhook API
  const webhooks = new Map();
  const heliusCalls = [];
  const helius = {
    list: async () => { heliusCalls.push('list'); return [...webhooks.values()]; },
    get: async (id) => {
      heliusCalls.push('get');
      if (!webhooks.has(id)) throw Object.assign(new Error('not found'), { status: 404 });
      return webhooks.get(id);
    },
    create: async (cfg) => {
      heliusCalls.push('create');
      const w = { ...cfg, webhookID: crypto.randomUUID(), active: true };
      webhooks.set(w.webhookID, w);
      return w;
    },
    update: async (id, cfg) => {
      heliusCalls.push('update');
      if (!webhooks.has(id)) throw Object.assign(new Error('not found'), { status: 404 });
      webhooks.set(id, { ...webhooks.get(id), ...cfg });
      return webhooks.get(id);
    },
    activate: async (id) => {
      heliusCalls.push('activate');
      webhooks.get(id).active = true;
      return webhooks.get(id);
    },
  };

  return { rpc, helius, transfer, batch, addTx, webhookItem, hidden, calls, webhooks, heliusCalls };
}
