// Database schema and migration. The schema is idempotent ("if not exists"), and migrate() only runs it
// when its text changed since the last run, under an advisory lock, so many cold-starting serverless
// instances never race each other.
import crypto from 'node:crypto';

// Amounts are whole $MCP tokens.
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
  deposit_address text,                 -- personal Solana address for deposits (filled by the deposit watcher)
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

const VERSION = crypto.createHash('sha256').update(SCHEMA).digest('hex').slice(0, 16);

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
    await t.query("insert into app_meta (key, value) values ('schema', $1) on conflict (key) do update set value = excluded.value", [VERSION]);
  });
  return true;
}
