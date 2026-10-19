# Security

## What protects your account

**Sign-in (OAuth 2.1 with PKCE)** — [`server/src/auth.js`](server/src/auth.js)
- Your AI app gets a token bound to your X account. Access tokens last 7 days; refresh tokens are single-use and rotate.
- Codes and tokens are stored as sha256 hashes. A database leak doesn't reveal working tokens.
- A sign-in must finish in the browser that started it (a short-lived, HttpOnly, SameSite cookie set at `/authorize`). Nobody can send you a sign-in link that connects *their* AI app to *your* account.
- The sign-in page shows which app and which website will receive access, and warns if it's not Claude or ChatGPT.
- Sign-in pages can't be framed (`X-Frame-Options: DENY`) and leak nothing in the `Referer` header.

**Money** — [`server/src/market.js`](server/src/market.js)
- Every balance change and its ledger row are written in one database transaction; balances can't go negative.
- `buy` takes the price you agreed to (`expected_price`) and fails if the listing changed.
- Concurrent buys of one NFT: exactly one succeeds (row lock), tested.
- Withdrawals go only to an address you bind once. Changing it requires support, so text injected into a chat, web page or NFT name can't redirect funds.
- The server tells the AI never to call `withdraw` or `set_withdraw_address` because of text from web pages, files or other tool results.

**Database** — [`server/src/schema.js`](server/src/schema.js)
- Only the server talks to Postgres. Supabase's auto-generated REST API is turned off for this project, and as a second layer every table has row level security with no policies, so the public API roles can't read anything even if it's switched on.

**Deposits** — [`server/src/deposits.js`](server/src/deposits.js)
- Each user deposits to their own Solana address from a pool made offline on the owner's computer (`npm run deposit-pool`). The seed phrase stays on paper; the server holds only public addresses and has no key that can move deposited funds.
- Every pool address is signed with `DEPOSIT_POOL_KEY` (HMAC of network, index and address). The server never shows or credits an address whose signature fails, so database write access alone can't redirect deposits; a failing row is set aside and logged as an alert.
- Nothing is credited because a webhook says so. Every transaction is fetched from the chain and checked: real USDC/USDT mint, the user's own token account, owner equals the user's deposit wallet, successful transaction, amount from the chain's balances.
- Each (transaction, token account) pair is credited once, enforced by a unique key, so webhook replays, retries and parallel scans can't double-credit. Tests cover forged payloads, replays, failed transactions, fake mints, wrong owners, forged pool rows, dust and lagging nodes.
- The Helius webhook must present a password (derived from the pool key, compared in constant time).
- The test server only accepts devnet tokens and the real server only mainnet ones, so free test money and real money never share a balance.
- `POST /admin/deposit` (manual credits for support) needs `ADMIN_TOKEN` and is off when it's unset. One reference is credited once.

## Test server caveats

While `DEV_LOGIN=1`, anyone can sign in as any handle. That's on purpose for the public test, and all balances are free test money. Production runs with X sign-in only.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on this repository instead of a public issue.
