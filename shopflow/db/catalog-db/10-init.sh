#!/bin/bash
# Runs once on first start of the catalog-db volume. One Postgres instance, two logical databases:
# `catalog` (read-mostly) and `inventory` (hot, transactional) -- a common cost-saving layout.
set -euo pipefail
PRODUCTS="${SEED_PRODUCTS:-5000}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
create database inventory;
create table products (
  id serial primary key, sku text unique not null, name text not null, category text not null,
  price_cents int not null, description text not null
);
insert into products(sku, name, category, price_cents, description)
select 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g,
       (array['shoes','shirts','hats','bags','socks','jackets'])[1 + g % 6],
       500 + (g * 37) % 20000,
       repeat('Lorem ipsum dolor sit amet. ', 4 + g % 8)
from generate_series(1, ${PRODUCTS}) g;
create index products_category_idx on products(category);
analyze products;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname inventory <<SQL
create table stock (sku text primary key, available int not null check (available >= 0), reserved int not null default 0);
insert into stock select 'SKU-' || lpad(g::text, 5, '0'), 1000000, 0 from generate_series(1, ${PRODUCTS}) g;
create table reservations (order_id uuid not null, sku text not null, qty int not null, primary key (order_id, sku));
SQL
