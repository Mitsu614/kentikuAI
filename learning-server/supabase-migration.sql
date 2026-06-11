-- learning_contributions テーブル作成
-- Learning Serverのデータ永続化用（Render再起動によるデータ消失を防止）
CREATE TABLE IF NOT EXISTS learning_contributions (
  id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  stats_data JSONB DEFAULT '[]'::jsonb,
  feedback_data JSONB DEFAULT '[]'::jsonb,
  stats_count INTEGER GENERATED ALWAYS AS (jsonb_array_length(stats_data)) STORED
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_learning_contributions_received_at ON learning_contributions (received_at DESC);

-- RLS（Row Level Security）無効化（サーバーサイドのみアクセス）
ALTER TABLE learning_contributions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON learning_contributions FOR ALL USING (true) WITH CHECK (true);
