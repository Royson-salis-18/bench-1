#!/bin/bash
# Schema + historical data. SEED_ORDERS sets how much history the database already holds.
# Staging typically has a few thousand rows; a year-old production database has millions.
set -euo pipefail
ROWS="${SEED_ORDERS:-5000}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
create table orders (
  id uuid primary key, user_id text not null, email text not null, total_cents int not null,
  status text not null, items jsonb not null, created_at timestamptz not null default now()
);
-- Lookups by id are covered by the primary key. History is read per user, newest first.
insert into orders(id, user_id, email, total_cents, status, items, created_at)
select gen_random_uuid(), 'hist-' || (g % 200000), 'hist-' || (g % 200000) || '@example.test', 1000 + g % 9000, 'paid',
       '[{"productId":1,"qty":1,"priceCents":1000}]'::jsonb, now() - (g || ' seconds')::interval
from generate_series(1, ${ROWS}) g;
analyze orders;
SQL
