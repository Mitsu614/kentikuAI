-- 建築ブースト 学習ループ用テーブル
-- Supabase SQL Editor で実行する

-- 1. 匿名化された施工実績データ（全テナントから集約）
CREATE TABLE IF NOT EXISTS estimate_feedback (
  id BIGSERIAL PRIMARY KEY,
  work_type TEXT NOT NULL,              -- 工事種別（例: キッチン交換、外壁塗装）
  region TEXT,                          -- 地域（例: 大阪府、東京都）
  structure_type TEXT,                  -- 構造（木造、RC造 等）
  area_m2 REAL,                        -- 面積
  ai_material_cost REAL,               -- AI見積: 材料費
  ai_labor_cost REAL,                  -- AI見積: 労務費
  ai_total REAL,                       -- AI見積: 合計
  ai_markup_rate REAL,                 -- AI見積: 利益率
  actual_material_cost REAL,           -- 実績: 材料費
  actual_labor_cost REAL,              -- 実績: 労務費
  actual_selling_price REAL,           -- 実績: 売値
  actual_markup_rate REAL,             -- 実績: 利益率
  accuracy_ratio REAL,                 -- 精度 = actual / ai_total
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 学習済み見積係数（GitHub Actionsが更新する）
CREATE TABLE IF NOT EXISTS cost_coefficients (
  id BIGSERIAL PRIMARY KEY,
  work_type TEXT NOT NULL UNIQUE,       -- 工事種別
  material_adjustment REAL DEFAULT 1.0, -- 材料費補正係数
  labor_adjustment REAL DEFAULT 1.0,    -- 労務費補正係数
  confidence REAL DEFAULT 0.0,          -- 信頼度（0〜1、データ数に基づく）
  sample_count INTEGER DEFAULT 0,       -- 元データ件数
  avg_accuracy REAL,                    -- 平均精度
  notes TEXT,                           -- AI分析メモ
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 学習実行ログ（いつ分析が走ったか記録）
CREATE TABLE IF NOT EXISTS learning_runs (
  id BIGSERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ DEFAULT NOW(),
  feedback_count INTEGER,               -- 分析した実績件数
  coefficients_updated INTEGER,         -- 更新した係数数
  summary TEXT,                         -- AI分析サマリー
  status TEXT DEFAULT 'success'
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_feedback_work_type ON estimate_feedback(work_type);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON estimate_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_coefficients_work_type ON cost_coefficients(work_type);

-- RLS (Row Level Security) ポリシー
ALTER TABLE estimate_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_coefficients ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_runs ENABLE ROW LEVEL SECURITY;

-- アプリからの読み書きを許可（anon key使用）
CREATE POLICY "Anyone can insert feedback" ON estimate_feedback
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can read coefficients" ON cost_coefficients
  FOR SELECT USING (true);

-- service_role key（GitHub Actions用）はRLSバイパスなので別途ポリシー不要
