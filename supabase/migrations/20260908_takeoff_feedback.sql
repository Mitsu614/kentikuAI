-- 図面からの数量拾い（takeoff）の学習ループを、全社で共有するための表。
--
-- 何を貯めるか:
--   AIが図面から拾った数量と、人が直した数量の対。
--   「この部位はAIが少なく拾う」「この単位で間違えやすい」を全社の実績から出すため。
--
-- 何を貯めないか（★重要）:
--   金額・単価・会社名・現場名・図面そのもの・場所は一切入れない。
--   入っているのは「部位の名前・単位・数量の比」だけなので、他社に見えても困らない。
--   これが金額の学習（estimate_feedback）と違って、隔離テナントも含めて全社共有にできる理由。
--
-- 実行方法: Supabaseのダッシュボード → SQL Editor にこのまま貼って実行する。
--   https://supabase.com/dashboard/project/slhgkedzlormaovwpadi/sql/new
--   ★ポリシーの文は1行で書くこと（複数行に折るとエディタによっては構文エラーになる）。

create table if not exists public.takeoff_feedback (id bigserial primary key, created_at timestamptz not null default now(), industry_type text, drawing_type text, scale text, item_key text not null, unit text, ai_quantity numeric not null, actual_quantity numeric not null, ratio numeric not null, note text);

create index if not exists takeoff_feedback_item_idx on public.takeoff_feedback (item_key, unit);
create index if not exists takeoff_feedback_created_idx on public.takeoff_feedback (created_at desc);

alter table public.takeoff_feedback enable row level security;

-- 全社で共有する表なので、書き込みも読み出しも許可する（金額・個社情報を持たないため）。
-- ★すでに作ってある環境では「already exists」で落ちる。そのエラーは無視してよい。
create policy takeoff_feedback_insert on public.takeoff_feedback for insert with check (true);
create policy takeoff_feedback_select on public.takeoff_feedback for select using (true);
