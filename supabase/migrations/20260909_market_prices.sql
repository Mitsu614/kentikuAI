-- 相場データベースを、アプリの更新なしで毎週配るための表。
--
-- 何を貯めるか:
--   AI見積が参照する相場（坪単価・材工単価・労務単価など）の全文と、
--   前の版から何をどう変えたかの記録。1行が1つの版。
--
-- なぜ要るか:
--   相場は app/src/main/cost-reference.ts に直書きされており、更新するには
--   アプリのリリースが要った。実際2026-07-13から止まっていた。
--   ここに置けば、週1回のGitHub Actionsが書き換え、全お客様が起動時に受け取れる。
--
-- 何を貯めないか:
--   会社名・案件・実額は一切入らない。全社共通の相場だけ。
--   （個社の金額は [金額はテナント隔離] の方針どおりクラウドへ出さない）
--
-- 書き込むのは GitHub Actions（service key）だけ。アプリは読むだけ。
--
-- 実行方法: Supabaseのダッシュボード → SQL Editor にこのまま貼って実行する。
--   https://supabase.com/dashboard/project/slhgkedzlormaovwpadi/sql/new
--   ★ポリシーの文は1行で書くこと（複数行に折るとエディタによっては構文エラーになる）。

create table if not exists public.market_prices (id bigserial primary key, created_at timestamptz not null default now(), version integer not null, content text not null, changes jsonb, held jsonb, model text, note text);

create unique index if not exists market_prices_version_idx on public.market_prices (version desc);

alter table public.market_prices enable row level security;

-- 読み出しは全員に許可（相場は全社共通で、個社の情報を持たないため）。
-- 書き込みのポリシーは作らない ＝ anon キーでは書けない。
-- 週次更新は service key で入れるので RLS を素通りする。
create policy market_prices_select on public.market_prices for select using (true);
