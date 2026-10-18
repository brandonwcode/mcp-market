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

**Deposit webhook**
- `POST /admin/deposit` needs `ADMIN_TOKEN` (constant-time comparison) and is off when it's unset. One transaction signature is credited once.

## Test server caveats

While `DEV_LOGIN=1`, anyone can sign in as any handle. That's on purpose for the public test, and all balances are free test money. Production runs with X sign-in only.

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on this repository instead of a public issue.
