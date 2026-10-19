# $MCP: the first memecoin inside your AI

<img src="site/logo.png" width="96" align="right" alt="MCP logo">

An NFT market that lives inside Claude and ChatGPT. You add one connector, sign in with X, and then just talk:
*"mint me an MCP"*, *"what's on the market under 10?"*, *"buy #0042"*, *"list my Scarf for 9"*, *"top up my balance"*

The website only shows the collection, prices and owners. Every action happens in your AI chat.

This repository is the whole server, so you can read exactly what the connector does before you plug it in.

> **Status: public test.** Sign in with X. Balances are in $MCP (1 $MCP = $1): free test $MCP from the faucet, or free devnet USDC deposited on Solana devnet. Nothing here is real money yet.

![Preview site](screens/market.png)

## Connect

**[➕ Add to Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=MCP&connectorUrl=https%3A%2F%2Fmcp-market.netlify.app%2Fmcp)** opens Claude with the connector filled in: check the URL, press *Continue* → *Add* → *Connect*, sign in. Works on every Claude plan (the free plan allows one custom connector).

**Connector URL:** `https://mcp-market.netlify.app/mcp`

- **Claude, by hand:** Customize → Connectors → *Add custom connector* → paste the URL → *Connect* → sign in.
- **ChatGPT:** Settings → Apps & Connectors → add a connector with the same URL → sign in.

Then ask for `faucet` to get test $MCP, or *"top up"* to get your deposit address, and start trading.

## What the connector can and can't do

These are all the tools the server exposes ([`server/src/mcp.js`](server/src/mcp.js)):

| Tool | What it does | Changes anything? |
|---|---|---|
| `account` | your handle, balance, NFTs, recent balance changes | no |
| `deposit` | your personal Solana address for USDC/USDT, and a check for new deposits | credits deposits that arrived |
| `faucet` | free test $MCP once a day (test server only) | your balance |
| `mint` | random NFT from the collection for 5 $MCP, max 5 per account | your balance, NFT owner |
| `my_nfts`, `market`, `nft` | look around | no |
| `buy` | buy a listed NFT; needs the exact price you agreed to | your balance, NFT owner |
| `sell`, `cancel_listing` | list your NFT or take it off sale | listing |
| `set_withdraw_address` | bind a Solana address for withdrawals, **once** | your account |
| `withdraw` | send $MCP out as USDC (1:1) to that bound address only | your balance |

**It can't:**
- see your chats, files, other connectors or anything outside this market;
- post on X, read your DMs or follow anyone: the X login asks only for `users.read tweet.read`, to learn your handle and avatar;
- send money anywhere except the one withdrawal address you bound yourself. Changing it needs support, so a prompt-injected AI can't redirect your funds.

**What the server stores:** your X id, handle, name and avatar; your balance, NFTs and a ledger of every balance change. OAuth codes and tokens are kept only as sha256 hashes. See [SECURITY.md](SECURITY.md) for the full list of protections.

## How it works

```
Claude / ChatGPT ──MCP over HTTPS──▶ /mcp ─┐
Your browser ──sign in──▶ /authorize, /login ─┤  one serverless function (Express)  ──▶  Postgres (Supabase)
Preview site ──▶ /api/* ───────────────────────┘
NFT images, site ──▶ CDN (static)
```

- **No blockchain for NFTs.** They are images on this server plus an owner row in the database. The chain is only the way in and out: deposit USDC or USDT on Solana, withdraw USDC back.
- **Balances are in $MCP, and 1 $MCP = $1.** You top up with USDC or USDT (1 token = 1 $MCP) and withdraw USDC. Amounts are stored as integer micro-units (6 decimals, exactly like USDC/USDT), so deposits are credited to the last unit.
- **Every balance change** writes a ledger row in the same database transaction, so balances always add up. The tests check this.
- **Market fee:** 2.5% of each sale goes to the treasury.

## Deposits

Every account gets its **own Solana deposit address**. Send USDC or USDT there from any wallet or exchange; no memo, no extra step. 1 USDC = 1 USDT = 1 $MCP on your balance.

```
owner's computer, offline:  seed phrase (on paper) ──npm run deposit-pool──▶ 10,000 public addresses (CSV)
                                                                                    │ import
user's wallet / exchange ──USDC/USDT──▶ their address from the pool ◀── deposit_pool table
                                              │
     Helius webhook ──▶ /hooks/helius ────────┤   each one fetches the transaction from the chain itself,
     "check my deposit" ──▶ deposit tool ─────┤   checks mint, owner and amount, and credits it once
     every 5 min ──▶ scheduled function ──────┘
```

- **The server can't move deposits.** Addresses are made in advance on the owner's computer from a seed phrase that stays on paper ([`server/scripts/deposit-pool.js`](server/scripts/deposit-pool.js)). The server only gets public addresses, hands one to each user and watches them. There is no key on the server to sign a transfer with, so even a full takeover of the server and the database can't take deposited funds. Wallet *n* is `m/44'/501'/n'/0'`, the path Phantom and Solflare use, so the phrase alone recovers everything.
- **Addresses can't be swapped.** Every address in the pool is signed (HMAC) with `DEPOSIT_POOL_KEY`, which the script derives from the phrase. The server shows and credits only addresses whose signature checks out, so someone who can write to the database can't slip in an address of their own.
- **What gets credited.** Only the real USDC and USDT mints, only into the token account of the user's own pool address, only successful transactions, only the amount the chain shows. The webhook payload is never trusted: it only says which transaction to look at. Each (transaction, token account) pair is credited at most once, enforced by a unique key. Amounts below 0.01 (spam "dust") are recorded and not credited.
- **Not lost if something fails.** Helius retries a webhook only three times, so the deposit tool checks on demand and a scheduled function (every 5 minutes, [`netlify/functions/deposits.mjs`](netlify/functions/deposits.mjs)) scans everyone who asked for an address in the last 2 hours, plus a rotating slice of everyone else.
- **Test server = devnet.** With `TEST_MODE=1` deposits are Solana devnet only (free USDC at [faucet.circle.com](https://faucet.circle.com)); the real server takes mainnet only. Mixing free test money with real money is refused at startup. Use different phrases for the two.
- **The webhook sets itself up.** The scheduled function creates one Helius webhook pointing at `/hooks/helius` and keeps its address list in sync.

### Making the address pool

On your own computer, with the repo cloned and `npm install` done (Wi-Fi can be off):

```bash
npm run deposit-pool -- --network mainnet          # new 24-word phrase, addresses #0..#9999
npm run deposit-pool -- --network mainnet --start 10000   # later: the next 10,000, same phrase
```

1. Write the 24 words on paper. They never go into a chat, a website, Netlify or the cloud.
2. Put the printed `DEPOSIT_POOL_KEY` into Netlify (it can't move money; it only signs the list).
3. Supabase → Table Editor → `deposit_pool` → Insert → *Import data from CSV* → the file the script wrote.

The scheduled function reports how many free addresses are left and warns when the pool runs low.

Code: [`server/src/deposits.js`](server/src/deposits.js), [`server/src/solana.js`](server/src/solana.js).

```
server/src/
  app.js      HTTP routes: /mcp, OAuth, public API, Helius webhook, manual credit
  mcp.js      the tools listed above
  market.js   rules: balances, mint, listings, buys, withdrawals
  money.js    $MCP amounts <-> micro-units
  deposits.js USDC/USDT deposits: address assignment, chain checks, webhook, scheduled scan
  pool.js     the offline-made deposit address pool and its HMAC
  solana.js   address derivation, token accounts, Solana RPC, Helius webhook API
  auth.js     OAuth for the connector + X sign-in
  schema.js   database tables and one-time data migrations
  lambda.js   serverless entry (Netlify Functions)
  cron.js     scheduled entry (deposit scan every 5 minutes)
  index.js    plain Node entry (npm start)
site/         the preview website
collection/   NFT images and traits
netlify/      Netlify function wrapper
```

## Run it locally

Node 22+.

```bash
npm install
cp .env.example .env      # test mode, embedded database, no setup needed
npm run demo              # optional: 8 fake traders so the site has something to show
npm start                 # http://localhost:3000, connector at http://localhost:3000/mcp
npm test                  # end-to-end tests: real OAuth, real MCP client, two users trading
```

## Deploy your own

1. **Database:** create a Supabase project. Copy *Connect → Transaction pooler* URI (port 6543). Tables are created on first start.
2. **Netlify:** import this repo. Build settings come from `netlify.toml`. Set the environment variables:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://<your-site>.netlify.app` |
| `DATABASE_URL` | the Supabase pooler URI |
| `TEST_MODE`, `DEV_LOGIN` | `1` for a test server; remove both for production |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | X app with OAuth 2.0, callback `PUBLIC_URL/login/x/callback` |
| `HELIUS_API_KEY` | from [helius.dev](https://helius.dev); used for Solana RPC and the deposit webhook |
| `DEPOSIT_POOL_KEY` | printed by `npm run deposit-pool` (see *Making the address pool*); then import the CSV into `deposit_pool` |
| `ADMIN_TOKEN` | optional: long random secret for manual credits (`POST /admin/deposit`); unset means off |
| `MINT_PRICE_USD`, `MIN_WITHDRAW_USD`, `MIN_DEPOSIT_USD`, `FAUCET_USD` | optional, in $MCP (= USD), defaults 5, 1, 0.01, 20 |

Deposits start working once `HELIUS_API_KEY` and `DEPOSIT_POOL_KEY` are set (and deployed) and the pool CSV is imported; the scheduled function registers the Helius webhook within 5 minutes of the first address handed out.

3. Smoke-test it: `npm run smoke -- https://<your-site>.netlify.app`

## Roadmap

- [x] Market, mint, OAuth connector, preview site, test server
- [x] Real X sign-in on the public server
- [x] Balances in $MCP, 1 $MCP = $1
- [x] Deposits: USDC/USDT on Solana to personal addresses, Helius webhook + scheduled scan
- [ ] Sweep script (runs on the owner's computer) + withdrawal hot wallet with limits (queued withdrawals are already recorded)
- [ ] Final collection

## Honest risks

- **Custodial.** Deposited tokens sit in addresses the project controls through one offline seed phrase, and the database is the source of truth for balances. Whoever holds the paper holds the funds.
- **Whoever controls the deployed code** (Netlify or GitHub accounts) could show users a different deposit address for new deposits. Those accounts need two-factor sign-in.
- **NFTs live on this server.** They exist as long as the server does.
- **Bots.** A server can't prove a request came from a human in Claude. Defenses: X sign-in, minimum account age, per-account mint limits.

## License

[MIT](LICENSE)
