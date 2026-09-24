-- 管理者を増やすための表（右腕など、オーナー以外の管理者）。
--
-- なぜ要るか:
--   これまで管理操作（承認・単位・停止・席数）は ADMIN_SECRET 1本で決まっていた。
--   これを人に教えると、その人だけを止める手段が無く、誰が操作したかも残らない。
--   そこで「人ごとの鍵」を発行し、操作はすべて記録する。
--
--   admin_keys  … 発行した鍵。**鍵そのものは保存しない**（SHA-256のハッシュだけ）。
--                 active=false にすれば、その人の鍵だけが即座に使えなくなる。
--   admin_audit … 管理操作の記録。誰が・いつ・何を・どの会社に。
--
-- 触るのは Edge Function（license, service key）だけ。
-- RLSを有効にしてポリシーを作らない ＝ anon キーでは読むことも書くこともできない。
--
-- 実行方法: Supabaseのダッシュボード → SQL Editor にこのまま貼って実行する。
--   https://supabase.com/dashboard/project/slhgkedzlormaovwpadi/sql/new

create table if not exists public.admin_keys (id bigserial primary key, name text not null, key_hash text not null unique, active boolean not null default true, created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz);

create table if not exists public.admin_audit (id bigserial primary key, at timestamptz not null default now(), actor text not null, sub text not null, company_name text, detail jsonb);

create index if not exists admin_audit_at_idx on public.admin_audit (at desc);

alter table public.admin_keys enable row level security;
alter table public.admin_audit enable row level security;
