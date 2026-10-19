// End-to-end suite: real HTTP, real OAuth flow, real MCP client, two users trading.
// Runs against any `setup()` that returns { base, db, close }: a plain Express server or the Lambda handler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deriveAddress, associatedTokenAddress } from '../src/solana.js';
import { webhookSecretFor } from '../src/deposits.js';
import { TEST_SEED, TEST_POOL_KEY, DEV_USDC, FAKE_USDT, randomAddress } from './fakechain.js';

const D = (dollars) => Math.round(dollars * 1e6); // dollars to micro-dollars, as stored

export function runSuite(setup) {
  let base, db, close, chain;

  before(async () => { ({ base, db, close, chain } = await setup()); });
  after(async () => { await close?.(); });

  const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

  // what the AI app does when the user adds the connector: register, open /authorize in the browser,
  // the user signs in on our page (dev sign-in in place of X), the app swaps the code for a token
  async function startLogin(redirect = 'http://localhost:9999/callback') {
    const reg = await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test AI', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    }).then((r) => r.json());
    assert.ok(reg.client_id, 'client registered: ' + JSON.stringify(reg));
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const auth = new URL(`${base}/authorize`);
    Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })
      .forEach(([k, v]) => auth.searchParams.set(k, v));
    const r1 = await fetch(auth, { redirect: 'manual' });
    assert.equal(r1.status, 302, await r1.text());
    const loginUrl = new URL(r1.headers.get('location'), base);
    assert.equal(loginUrl.pathname, '/login');
    return { reg, verifier, redirect, loginUrl, cookie: cookieOf(r1), req: loginUrl.searchParams.get('req') };
  }

  async function connect(handle) {
    const s = await startLogin();
    const page = await fetch(s.loginUrl, { headers: { cookie: s.cookie } }).then((r) => r.text());
    assert.match(page, /Test sign-in/);
    const r2 = await fetch(`${base}/login/dev`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: s.cookie },
      body: new URLSearchParams({ req: s.req, handle }),
    });
    assert.equal(r2.status, 302, await r2.text());
    const back = new URL(r2.headers.get('location'));
    assert.equal(back.searchParams.get('state'), 'xyz');
    const tok = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: s.verifier, client_id: s.reg.client_id, redirect_uri: s.redirect }),
    }).then((r) => r.json());
    assert.ok(tok.access_token, 'got access token: ' + JSON.stringify(tok));
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
    return { client, tok, reg: s.reg };
  }

  const call = async (c, name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n'), images: r.content.filter((x) => x.type === 'image'), isError: !!r.isError };
  };
  const balanceOf = async (handle) => Number((await db.query('select balance from users where handle = $1', [handle]))[0].balance);
  const ledgerMatchesBalances = async () => {
    const bad = await db.query(`select u.handle from users u left join (select user_id, sum(delta) s from ledger group by user_id) l on l.user_id = u.id
      where u.balance <> coalesce(l.s, 0)`);
    assert.deepEqual(bad, []);
  };

  test('discovery: unauthenticated MCP calls get 401 pointing at our OAuth metadata', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata=/);
    const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((x) => x.json());
    assert.ok(meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint);
    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((x) => x.json());
    assert.match(prm.resource, /\/mcp$/);
  });

  test('sign-in links only work in the browser that started them', async () => {
    const s = await startLogin();
    assert.ok(s.cookie.startsWith('mcp_login_'), 'authorize marks the browser');
    // someone else opens the link (no cookie): refused
    const stolen = await fetch(s.loginUrl);
    assert.equal(stolen.status, 403);
    const post = await fetch(`${base}/login/dev`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ req: s.req, handle: 'victim' }),
    });
    assert.equal(post.status, 403);
    // the right browser: allowed
    assert.equal((await fetch(s.loginUrl, { headers: { cookie: s.cookie } })).status, 200);
  });

  test('sign-in page warns when access goes somewhere other than Claude or ChatGPT', async () => {
    const s = await startLogin('https://evil.example/cb');
    const page = await fetch(s.loginUrl, { headers: { cookie: s.cookie } }).then((r) => r.text());
    assert.match(page, /evil\.example/);
    assert.match(page, /not Claude or ChatGPT/);
    const ok = await startLogin('https://claude.ai/api/mcp/auth_callback');
    const page2 = await fetch(ok.loginUrl, { headers: { cookie: ok.cookie } }).then((r) => r.text());
    assert.doesNotMatch(page2, /not Claude or ChatGPT/);
  });

  test('full market flow between two users', async () => {
    const { client: alice, tok } = await connect('alice');
    const { client: bob } = await connect('bob');

    // tokens are stored hashed
    const plain = await db.query('select 1 from oauth_tokens where token = $1 or token = $2', [tok.access_token, tok.refresh_token]);
    assert.equal(plain.length, 0, 'no plain-text tokens in the database');

    const tools = (await alice.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['account', 'buy', 'cancel_listing', 'deposit', 'faucet', 'market', 'mint', 'my_nfts', 'nft', 'sell', 'set_withdraw_address', 'withdraw'].sort());

    // no money yet
    assert.equal((await call(alice, 'mint')).isError, true);
    assert.match((await call(alice, 'faucet')).text, /Added 20 \$MCP of test money/);
    assert.equal((await call(alice, 'faucet')).isError, true, 'faucet once a day');

    const m1 = await call(alice, 'mint');
    assert.equal(m1.isError, false, m1.text);
    assert.equal(m1.images.length, 1, 'mint returns the NFT image');
    const id1 = Number(m1.text.match(/MCP #(\d+)/)[1]);
    const m2 = await call(alice, 'mint');
    const id2 = Number(m2.text.match(/MCP #(\d+)/)[1]);
    assert.notEqual(id1, id2);
    assert.equal(await balanceOf('alice'), D(10));

    // only the owner can list; prices have at most 2 decimals
    assert.equal((await call(bob, 'sell', { nft_id: id1, price: 5 })).isError, true);
    const fraction = await call(alice, 'sell', { nft_id: id1, price: 8.005 });
    assert.equal(fraction.isError, true);
    assert.match(fraction.text, /at most 2 decimals/);
    const listed = await call(alice, 'sell', { nft_id: id1, price: 8 });
    assert.match(listed.text, /listed at 8 \$MCP\. If it sells you get 7\.80 \$MCP/);
    assert.match((await call(bob, 'market')).text, new RegExp(`MCP #${String(id1).padStart(4, '0')}.* 8 \\$MCP`));

    await call(bob, 'faucet');
    // price guard: bob agreed to $7, the listing says $8
    const wrong = await call(bob, 'buy', { nft_id: id1, expected_price: 7 });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /Price changed: .* now costs 8 \$MCP/);
    const ok = await call(bob, 'buy', { nft_id: id1, expected_price: 8 });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(await balanceOf('bob'), D(12));
    assert.equal(await balanceOf('alice'), D(10) + D(8) - D(0.2), 'seller gets price minus 2.5% fee');
    assert.equal((await call(bob, 'buy', { nft_id: id1, expected_price: 8 })).isError, true, 'no longer for sale');

    const nft = await call(alice, 'nft', { nft_id: id1 });
    assert.match(nft.text, /owner @bob/);
    assert.match(nft.text, /8 \$MCP @alice → @bob/);
    assert.equal(nft.images.length, 1);

    // listing then cancel
    await call(alice, 'sell', { nft_id: id2, price: 3 });
    assert.match((await call(alice, 'cancel_listing', { nft_id: id2 })).text, /no longer for sale/);

    // withdrawals: address first, bound once
    assert.equal((await call(alice, 'withdraw', { amount: 100 })).isError, true);
    assert.equal((await call(alice, 'set_withdraw_address', { address: 'not-an-address-not-an-address-xx' })).isError, true);
    const addr = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    assert.equal((await call(alice, 'set_withdraw_address', { address: addr })).isError, false);
    assert.equal((await call(alice, 'set_withdraw_address', { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' })).isError, true);
    assert.equal((await call(alice, 'withdraw', { amount: 0.5 })).isError, true, 'below the $1 minimum');
    assert.match((await call(alice, 'withdraw', { amount: 1 })).text, /Withdrawal #\d+ of 1 \$MCP .* queued/);
    assert.equal(await balanceOf('alice'), D(16.8));
    assert.equal((await call(alice, 'withdraw', { amount: 999.99 })).isError, true);

    // mint limit
    for (let i = 0; i < 3; i++) await call(alice, 'mint');
    const over = await call(alice, 'mint');
    assert.equal(over.isError, true);
    assert.match(over.text, /limit/i);

    // every balance equals the sum of its ledger rows
    await ledgerMatchesBalances();

    const acct = await call(alice, 'account');
    assert.match(acct.text, /@alice/);
    assert.match(acct.text, /Balance: 1\.80 \$MCP/);
    assert.match(acct.text, /-5 \$MCP mint MCP #/);
  });

  test('refresh token rotates and the old one stops working', async () => {
    const { tok, reg } = await connect('refresher');
    const refresh = (t) => fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t, client_id: reg.client_id }),
    });
    const r1 = await refresh(tok.refresh_token);
    assert.equal(r1.status, 200);
    const t2 = await r1.json();
    assert.ok(t2.access_token && t2.refresh_token);
    assert.equal((await refresh(tok.refresh_token)).status, 400, 'old refresh token is single-use');
  });

  test('concurrent buys of one NFT: exactly one wins', async () => {
    const { client: seller } = await connect('seller');
    await call(seller, 'faucet');
    const id = Number((await call(seller, 'mint')).text.match(/MCP #(\d+)/)[1]);
    await call(seller, 'sell', { nft_id: id, price: 10 });
    const buyers = await Promise.all(['c1', 'c2', 'c3'].map(connect));
    await Promise.all(buyers.map((b) => call(b.client, 'faucet')));
    const results = await Promise.all(buyers.map((b) => call(b.client, 'buy', { nft_id: id, expected_price: 10 })));
    assert.equal(results.filter((r) => !r.isError).length, 1);
    const total = (await Promise.all(['c1', 'c2', 'c3'].map(balanceOf))).reduce((a, b) => a + b, 0);
    assert.equal(total, D(3 * 20 - 10));
  });

  test('manual credit needs the admin token and credits once per reference', async () => {
    const post = (body, token) => fetch(`${base}/admin/deposit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post({ handle: 'bob', amount: 5, tx: 'sig1' })).status, 401);
    assert.equal((await post({ handle: 'bob', amount: 5, tx: 'sig1' }, 'wrong-secret')).status, 401);
    assert.equal((await post({ handle: 'bob', amount: -5, tx: 'sig1' }, 'admin-secret')).status, 400);
    const before = await balanceOf('bob');
    assert.deepEqual(await (await post({ handle: 'bob', amount: 5, tx: 'sig1' }, 'admin-secret')).json(), { duplicate: false });
    assert.deepEqual(await (await post({ handle: 'bob', amount: 5, tx: 'sig1' }, 'admin-secret')).json(), { duplicate: true });
    assert.equal(await balanceOf('bob'), before + D(5));
  });

  test('deposits: personal address, webhook, on-demand check, each transaction credited once', async () => {
    const { client: dora } = await connect('dora');
    const [u] = await db.query("select id from users where handle = 'dora'");
    const deposit = () => call(dora, 'deposit');
    assert.match((await call(dora, 'account')).text, /Deposit address: none yet/);

    // first call hands out the next address of the pool (made offline from the phrase) and watches
    // its USDC and USDT accounts
    const first = await deposit();
    assert.equal(first.isError, false, first.text);
    const [p] = await db.query("select idx, address from deposit_pool where network = 'devnet' and user_id = $1", [u.id]);
    const wallet = p.address;
    assert.equal(wallet, deriveAddress(TEST_SEED, p.idx), 'the address is wallet #idx of the phrase');
    const usdcAta = associatedTokenAddress(wallet, DEV_USDC);
    const usdtAta = associatedTokenAddress(wallet, FAKE_USDT);
    assert.match(first.text, new RegExp(`\\n${wallet}\\n`));
    assert.match(first.text, /USDC or USDT on Solana devnet/);
    assert.match(first.text, /No deposits yet/);
    assert.match(first.text, /faucet\.circle\.com/);
    assert.match((await deposit()).text, new RegExp(`\\n${wallet}\\n`), 'same address every time');
    const watched = await db.query('select address, token from deposit_accounts where user_id = $1 order by token', [u.id]);
    assert.deepEqual(watched, [{ address: usdcAta, token: 'USDC' }, { address: usdtAta, token: 'USDT' }]);
    assert.match((await call(dora, 'account')).text, new RegExp(`Deposit address: ${wallet}`));

    // Helius calls the webhook; only with the right password
    const sig1 = chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(25.5), before: null });
    const hook = (body, auth) => fetch(`${base}/hooks/helius`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
    });
    const secret = webhookSecretFor(TEST_POOL_KEY);
    assert.equal((await hook([chain.webhookItem(sig1)])).status, 401);
    assert.equal((await hook([chain.webhookItem(sig1)], 'nope')).status, 401);
    // a forged payload is not believed: the amount comes from the chain
    const forged = chain.webhookItem(sig1);
    forged.meta.postTokenBalances[1].uiTokenAmount.amount = String(D(1_000_000));
    const r1 = await (await hook([forged], secret)).json();
    assert.equal(r1.credited, 1);
    assert.equal(await balanceOf('dora'), D(25.5));
    // replays credit nothing
    assert.equal((await (await hook([chain.webhookItem(sig1)], secret)).json()).credited, 0);
    const again = await deposit();
    assert.match(again.text, /Deposits in the last 24 hours:\n\+25\.50 \$MCP \(25\.50 USDC, tx /);
    assert.equal(await balanceOf('dora'), D(25.5));

    // no webhook at all: the deposit tool finds it (USDT, receiving account in a v0 lookup table)
    chain.transfer({ mint: FAKE_USDT, to: usdtAta, owner: wallet, amount: D(10), inLookupTable: true });
    assert.match((await deposit()).text, /New deposits:\n\+10 \$MCP \(10 USDT, tx /);
    assert.equal(await balanceOf('dora'), D(35.5));

    // not credited: dust, failed transactions, money going out, other tokens, accounts that aren't the user's
    chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: 900, before: D(25.5) });
    chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(50), before: D(25.5), err: { InstructionError: [0, 'Custom'] } });
    const fakeMint = randomAddress();
    chain.transfer({ mint: fakeMint, to: usdcAta, owner: wallet, amount: D(500) });
    chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(70), before: D(25.5), ownerInPost: randomAddress() });
    chain.addTx({
      accountKeys: [usdcAta, randomAddress()],
      pre: [{ accountIndex: 0, mint: DEV_USDC, owner: wallet, uiTokenAmount: { amount: String(D(25.5)), decimals: 6 } }],
      post: [{ accountIndex: 0, mint: DEV_USDC, owner: wallet, uiTokenAmount: { amount: String(D(5)), decimals: 6 } }],
    });
    const quiet = await deposit();
    assert.match(quiet.text, /0\.0009 USDC received, not credited: below the 0\.01 USDC minimum/);
    assert.equal(await balanceOf('dora'), D(35.5));

    // a node that can't see the transaction yet: nothing is skipped, it is credited on the next check
    const late = chain.transfer({ mint: DEV_USDC, to: usdcAta, owner: wallet, amount: D(3), before: D(5) });
    chain.hidden.add(late);
    await deposit();
    assert.equal(await balanceOf('dora'), D(35.5));
    chain.hidden.delete(late);
    assert.match((await deposit()).text, /New deposits:\n\+3 \$MCP \(3 USDC, tx /);
    assert.equal(await balanceOf('dora'), D(38.5));

    // one transaction paying two of our users (an exchange batch payout) credits both
    const { client: eve } = await connect('eve');
    await call(eve, 'deposit');
    const [e] = await db.query("select p.address from deposit_pool p join users u on u.id = p.user_id where u.handle = 'eve'");
    assert.notEqual(e.address, wallet, 'everyone gets their own address');
    const eveAta = associatedTokenAddress(e.address, DEV_USDC);
    const both = chain.batch(DEV_USDC, [{ to: eveAta, owner: e.address, amount: D(7) }, { to: usdcAta, owner: wallet, amount: D(1.25) }]);
    assert.equal((await (await hook([chain.webhookItem(both)], secret)).json()).credited, 2);
    assert.equal(await balanceOf('eve'), D(7));
    assert.equal(await balanceOf('dora'), D(39.75));

    const acct = await call(dora, 'account');
    assert.match(acct.text, /\+1\.25 \$MCP deposit USDC \(tx \w{6}…\w{4}\)/);
    await ledgerMatchesBalances();
  });

  test('public preview API', async () => {
    const s = await fetch(`${base}/api/stats`).then((r) => r.json());
    assert.equal(s.supply, 120);
    assert.equal(s.minted, 6, 'alice minted 5, seller minted 1');
    assert.equal(s.test_mode, true);
    assert.equal(s.currency, 'MCP');
    assert.equal(s.usd_per_mcp, 1);
    assert.equal(s.mint_price, 5);
    assert.deepEqual(s.deposits, { network: 'solana-devnet', tokens: ['USDC', 'USDT'] });
    const listed = await fetch(`${base}/api/nfts?status=listed&sort=price_asc`).then((r) => r.json());
    assert.ok(Array.isArray(listed));
    const one = await fetch(`${base}/api/nfts/1`).then((r) => r.json());
    assert.equal(one.name, 'MCP #0001');
    assert.equal((await fetch(`${base}/api/nfts/abc`)).status, 404);
    const u = await fetch(`${base}/api/users/alice`).then((r) => r.json());
    assert.ok(u.nfts.length >= 1);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test('database: row level security is on for every table', async () => {
    const rows = await db.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    assert.deepEqual(rows, []);
  });

  return { get base() { return base; } };
}
