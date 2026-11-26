-- Supabase setup for the Stock Screener picks.
-- Paste this whole file into Supabase > SQL Editor > New query > Run.

-- One row per starred pick (replaces localStorage keys cts_liked_setup_1 / _2 / _ph)
create table if not exists picks (
  id              bigint generated always as identity primary key,
  setup_id        text        not null,            -- '1', '2' or 'ph'
  ticker          text        not null,
  starred_at      timestamptz not null,
  score           numeric,
  tf_norm         jsonb       not null default '{}',
  criteria_vector jsonb       not null default '{}',
  created_at      timestamptz not null default now(),
  unique (setup_id, ticker, starred_at)
);

-- Chart bars for each pick (replaces cts_picks_bars_recent / _archive).
-- Kept in its own table because it is the heavy part.
create table if not exists pick_bars (
  ticker      text        not null,
  starred_at  timestamptz not null,
  bars        jsonb       not null default '{}',   -- daily / weekly / monthly bars
  updated_at  timestamptz not null default now(),
  primary key (ticker, starred_at)
);

create index if not exists picks_ticker_idx on picks (ticker);
create index if not exists picks_starred_idx on picks (starred_at desc);

-- Lock the tables: only the server (which holds the secret key) can read/write.
-- The browser never talks to Supabase directly, so your key stays private.
alter table picks     enable row level security;
alter table pick_bars enable row level security;

-- Newer Supabase projects don't give the server's key access to new tables automatically.
grant usage on schema public to service_role;
grant all on table public.picks to service_role;
grant all on table public.pick_bars to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Watchlist .txt files (the 3 sidebar slots + the Watchlist Check slot). One row per slot, latest file wins.
create table if not exists watchlists (
  slot        text primary key,            -- '0', '1', '2' or 'refine'
  name        text        not null,        -- original file name
  tickers     jsonb       not null default '[]',
  raw_text    text,                        -- the .txt file exactly as uploaded
  updated_at  timestamptz not null default now()
);
alter table watchlists enable row level security;
grant all on table public.watchlists to service_role;
