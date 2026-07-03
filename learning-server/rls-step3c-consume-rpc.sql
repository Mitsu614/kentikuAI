-- =====================================================================
-- STEP3-c: クレジット消費を「原子更新」にする関数 consume_credits
--
-- 目的: Edge Function の consume が read→減算→write（非原子）だと、
--       同一トークンの並行 consume で二重消費（ロストアップデート）が起きる。
--       行ロック(FOR UPDATE)付きの関数にまとめて、確実に1回ずつ減算する。
--
-- 非破壊: 既存データは変えない。関数を追加するだけ。
-- Supabase → SQL Editor に貼って Run。実行後、license Edge Function を再デプロイすること。
-- =====================================================================

create or replace function public.consume_credits(p_token text, p_amount int)
returns table(status text, credits int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      text;
  v_active  boolean;
  v_credits int;
begin
  -- 対象行をロックして取得（同時実行はここで直列化される）
  select id, active, credits
    into v_id, v_active, v_credits
    from public.remote_licenses
   where license_token = p_token
   for update;

  if v_id is null then
    return query select 'invalid_token'::text, 0; return;
  end if;
  if not coalesce(v_active, false) then
    return query select 'inactive'::text, coalesce(v_credits, 0); return;
  end if;
  if coalesce(v_credits, 0) < greatest(p_amount, 0) then
    return query select 'insufficient'::text, coalesce(v_credits, 0); return;
  end if;

  update public.remote_licenses
     set credits = credits - greatest(p_amount, 0),
         updated_at = now()
   where id = v_id;

  return query select 'ok'::text, (coalesce(v_credits, 0) - greatest(p_amount, 0)); return;
end;
$$;

-- 公開キー(anon)やpublicからは呼べないようにし、Edge Function(service_role)だけに許可。
-- （STEP3の「remote_licensesに触れるのはEdge Functionだけ」という原則を関数にも適用）
revoke all on function public.consume_credits(text, int) from public;
revoke all on function public.consume_credits(text, int) from anon;
grant execute on function public.consume_credits(text, int) to service_role;

-- 確認: 存在チェック
-- select proname from pg_proc where proname = 'consume_credits';
