// Database schema and migration. The schema is idempotent ("if not exists"), and migrate() only runs it
// when its text changed since the last run, under an advisory lock, so many cold-starting serverless
// instances never race each other.
import crypto from 'node:crypto';

// Amounts are integer micro-units of $MCP (1 $MCP = $1 = 1,000,000 units), like USDC/USDT on Solana. See money.js.
export const SCHEMA = `
create table if not exists app_meta (
  key text primary key,
  value text not null
);

create table if not exists users (
  id serial primary key,
  x_id text unique not null,            -- X (Twitter) user id; 'dev:<handle>' for test logins
  handle text unique not null,
  name text,
  avatar text,
  balance bigint not null default 0 check (balance >= 0),
  deposit_address text,                 -- unused: deposit addresses live in deposit_pool
  withdraw_address text,                -- bound once; changing it needs support
  created_at timestamptz not null default now()
);

create table if not exists nfts (
  id int primary key,
  name text not null,
  character text not null,
  shape text not null,
  palette text not null,
  rarity text not null,
  owner_id int references users(id),
  minted_at timestamptz,
  price bigint check (price > 0),       -- not null = listed for sale
  listed_at timestamptz
);
create index if not exists nfts_owner on nfts(owner_id);
create index if not exists nfts_listed on nfts(price) where price is not null;

create table if not exists ledger (
  id bigserial primary key,
  user_id int references users(id),     -- null = project treasury (fees, mint revenue)
  delta bigint not null,
  kind text not null,                   -- deposit | faucet | mint | buy | sale | fee | withdraw
  ref text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_user on ledger(user_id, id desc);
create unique index if not exists ledger_deposit_tx on ledger(ref) where kind = 'deposit';

-- Deposits. deposit_pool holds public Solana addresses made offline from a phrase the server never sees
-- (server/scripts/deposit-pool.js, imported as CSV). Each user gets one. We watch its USDC and USDT token
-- accounts and credit what arrives. Each (transaction, token account) is credited at most once.
create table if not exists deposit_pool (
  network text not null,                -- mainnet | devnet
  idx int not null,                     -- the phrase's wallet number: m/44'/501'/idx'/0'
  address text not null unique,
  mac text not null,                    -- HMAC of network:idx:address with DEPOSIT_POOL_KEY (see pool.js)
  user_id int references users(id),
  assigned_at timestamptz,
  primary key (network, idx)
);
create unique index if not exists deposit_pool_user on deposit_pool(network, user_id);
create index if not exists deposit_pool_free on deposit_pool(network, idx) where user_id is null;

alter table users add column if not exists deposit_watch_until timestamptz; -- scan often until then

create table if not exists deposit_accounts (
  address text primary key,             -- the pool address's associated token account for one stablecoin
  user_id int not null references users(id),
  wallet text not null,                 -- the pool address that owns it
  token text not null,                  -- USDC | USDT
  mint text not null,
  cursor text,                          -- newest transaction signature already processed
  checked_at timestamptz
);
create index if not exists deposit_accounts_user on deposit_accounts(user_id);

create table if not exists deposits (
  id bigserial primary key,
  user_id int not null references users(id),
  signature text not null,
  token text not null,
  token_account text not null,
  amount bigint not null,               -- micro-units ($MCP = token amount, 6 decimals)
  slot bigint,
  status text not null,                 -- credited | too_small
  created_at timestamptz not null default now(),
  unique (signature, token_account)
);
create index if not exists deposits_user on deposits(user_id, id desc);

create table if not exists sales (
  id bigserial primary key,
  nft_id int not null references nfts(id),
  seller_id int not null references users(id),
  buyer_id int not null references users(id),
  price bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists withdrawals (
  id bigserial primary key,
  user_id int not null references users(id),
  amount bigint not null check (amount > 0),
  address text not null,
  status text not null default 'pending', -- pending | sent | failed
  tx text,
  created_at timestamptz not null default now()
);

-- OAuth for the MCP connector. Codes and tokens are stored as sha256 hashes, never in plain text.
create table if not exists oauth_clients (
  client_id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists oauth_pending (
  id text primary key,                  -- one login attempt, from /authorize until the user signs in
  client_id text not null,
  params jsonb not null,
  x_verifier text,
  created_at timestamptz not null default now()
);
create table if not exists oauth_codes (
  code text primary key,                -- sha256 of the authorization code
  client_id text not null,
  user_id int not null references users(id),
  challenge text not null,
  redirect_uri text not null,
  expires_at timestamptz not null
);
create table if not exists oauth_tokens (
  token text primary key,               -- sha256 of the access / refresh token
  kind text not null,                   -- access | refresh
  client_id text not null,
  user_id int not null references users(id),
  expires_at timestamptz not null
);
create index if not exists oauth_tokens_expiry on oauth_tokens(expires_at);

-- Only this server talks to the database. Row level security with no policies means that even if
-- Supabase's auto-generated REST API is ever switched on, its roles see nothing.
alter table app_meta enable row level security;
alter table users enable row level security;
alter table nfts enable row level security;
alter table ledger enable row level security;
alter table sales enable row level security;
alter table withdrawals enable row level security;
alter table deposit_pool enable row level security;
alter table deposit_accounts enable row level security;
alter table deposits enable row level security;
alter table oauth_clients enable row level security;
alter table oauth_pending enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end $$;
`;

// One-time data changes, applied once each, in order, under the same lock as the schema.
const DATA_MIGRATIONS = [
  // 2026-10-19: the currency moved from whole $MCP test tokens to US dollars. 1 old token = 1 cent,
  // so the old mint price of 500 becomes $5.00 and a sale at 999 becomes $9.99.
  ['usd-micro', `
    update users set balance = balance * 10000;
    update ledger set delta = delta * 10000;
    update nfts set price = price * 10000 where price is not null;
    update sales set price = price * 10000;
    update withdrawals set amount = amount * 10000;`],
];

const VERSION = crypto.createHash('sha256').update(SCHEMA + DATA_MIGRATIONS.map(([k]) => k).join(',')).digest('hex').slice(0, 16);

async function appliedVersion(q) {
  const [r] = await q("select to_regclass('app_meta') is not null as ok");
  if (!r.ok) return null;
  const [row] = await q("select value from app_meta where key = 'schema'");
  return row?.value ?? null;
}

export async function migrate(db) {
  if (await appliedVersion(db.query) === VERSION) return false;
  await db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock(727274001)');
    if (await appliedVersion(t.query) === VERSION) return;
    await t.exec(SCHEMA);
    for (const [name, sql] of DATA_MIGRATIONS) {
      const key = `data:${name}`;
      const [done] = await t.query('select 1 from app_meta where key = $1', [key]);
      if (done) continue;
      await t.exec(sql);
      await t.query('insert into app_meta (key, value) values ($1, now()::text)', [key]);
    }
    await t.query("insert into app_meta (key, value) values ('schema', $1) on conflict (key) do update set value = excluded.value", [VERSION]);
  });
  return true;
}
