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
- Withdrawals go only to an address you bind once. Changing it requires support, so text injected into a chat, web page or NFT name can't redirect funds. It can't be a token account or one of the market's own addresses; on the real server the first withdrawal opens 24 hours after binding.
- The server tells the AI never to call `withdraw` or `set_withdraw_address` because of text from web pages, files or other tool results, and to confirm amount, fee and address with you first.

**Withdrawals** — [`server/src/withdrawals.js`](server/src/withdrawals.js)
- Payouts come from a hot wallet holding a small float; it is the only key the server has. Deposits stay in addresses only the offline phrase controls.
- A withdrawal is never paid twice. Every signed transaction is stored before broadcasting and can't be changed or deleted (trigger); a new one is built only when the finalized block height (asked first) is past every earlier one's last valid height plus a margin, and a status lookup from a node at least that current shows none landed (a failed landing counts only once finalized). Errors from the network count as "maybe received", and `sendTransaction` is never retried automatically. Every state change is made under a row lock and only if the status and the number of stored transactions are unchanged. Only signatures the server stored are trusted. Tested with lost responses, refusals, dropped, late and last-block transactions, stale status nodes, parallel instances with random faults (chaos test, also on Postgres), outsider transactions carrying our memo, and rows reset in the database. Two independent reviews' findings are fixed.
- A rejected withdrawal is refunded only when none of its transactions landed or can still land, at most once (unique ledger key), and `refunded` is final: it can't be paid afterwards.
- `sent` and `refunded` are final and a withdrawal's amount, fee, address and user can't be changed (database triggers), so mistakes in the table editor can't cause a double payment.
- Withdrawal rows and address bindings are HMAC-signed (key derived from `DEPOSIT_POOL_KEY`, independent of the hot wallet), and a withdrawal needs the balance to match the ledger: a row or binding created or changed in the database is not paid. Full control of the database could still inflate an account's balance and withdraw it; a hard daily payout cap and the hot wallet float limit that.
- Automatic payouts are limited per withdrawal, per user per day and in total per day; larger ones wait for the owner.

**Database** — [`server/src/schema.js`](server/src/schema.js)
- Only the server talks to Postgres. Supabase's auto-generated REST API is turned off for this project, and as a second layer every table has row level security with no policies, so the public API roles can't read anything even if it's switched on.

**Deposits** — [`server/src/deposits.js`](server/src/deposits.js)
- Each user deposits to their own Solana address from a pool made offline on the owner's computer (`npm run deposit-pool`). The seed phrase stays on paper; the server holds only public addresses and has no key that can move deposited funds.
- Every pool address is signed with `DEPOSIT_POOL_KEY` (HMAC of network, index and address). The server never shows or credits an address whose signature fails, so database write access alone can't redirect deposits; a failing row is set aside and logged as an alert.
- Nothing is credited because a webhook says so. Every transaction is fetched from the chain and checked: real USDC/USDT mint, the user's own token account, owner equals the user's deposit wallet, successful transaction, amount from the chain's balances.
- Each (transaction, token account) pair is credited once, enforced by a unique key, so webhook replays, retries and parallel scans can't double-credit. Money moving out of one of our own pool addresses (the owner's sweep) is never credited, and a transaction support already credited by hand is not credited again. Tests cover forged payloads, replays, failed transactions, fake mints, wrong owners, forged pool rows, internal transfers, dust and lagging nodes.
- The Helius webhook must present a password (derived from the pool key, compared in constant time).
- The test server only accepts devnet tokens and the real server only mainnet ones, so free test money and real money never share a balance.
- `POST /admin/deposit` (manual credits for support) needs `ADMIN_TOKEN` and is off when it's unset. One reference is credited once.

## Test server caveats

While `DEV_LOGIN=1`, anyone can sign in as any handle. That's on purpose for the public test, and all balances are free test money. Production runs with X sign-in only.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on this repository instead of a public issue.
