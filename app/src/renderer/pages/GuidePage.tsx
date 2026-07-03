import React, { useState } from 'react';

const sections = [
  {
    title: 'AI 見積もり',
    icon: '🤖',
    steps: [
      '左メニューの「AI 見積もり」を開く',
      'チャット欄に工事内容を入力（例:「3LDK マンション キッチン交換」）',
      '現場写真があれば添付するとAIの精度がアップ',
      'AIが材料費・人件費・合計金額を自動算出',
      '金額が違う場合は修正 → AIが学習して次回から精度向上',
    ],
  },
  {
    title: '写真から見積',
    icon: '📷',
    steps: [
      '「AI 見積もり」画面で写真アイコンをクリック',
      '現場写真を選択またはドラッグ＆ドロップ',
      'AIが写真から工事内容を自動判定',
      '見積金額が自動生成される',
    ],
  },
  {
    title: '紙を電子化（OCR）',
    icon: '📸',
    steps: [
      '左メニューの「紙を電子化」を開く',
      '紙の見積書・請求書の写真をアップロード',
      'AIが文字を読み取ってデータ化',
      '読み取り結果を確認・修正して保存',
    ],
  },
  {
    title: '施工・見積管理',
    icon: '🔨',
    steps: [
      '「施工・見積」で工事一覧を管理',
      '「+ 新規」で工事を手動追加（AI見積からの自動登録も可）',
      '工事をクリックして詳細を編集',
      '見積書PDFをワンクリックで出力',
    ],
  },
  {
    title: '請求書・発注書',
    icon: '📄',
    steps: [
      '「請求書」で請求書を作成・管理',
      '施工データから自動で金額が反映',
      'PDFで出力・印刷が可能',
      '「発注書」も同様の操作で作成可能',
    ],
  },
  {
    title: '物件管理',
    icon: '🏠',
    steps: [
      '「物件管理」で物件情報を登録',
      '物件に紐づく施工・請求書を一元管理',
      '物件ごとの売上・利益を自動集計',
    ],
  },
  {
    title: '出面管理・作業日報',
    icon: '📋',
    steps: [
      '「出面管理」で日々の出面を記録',
      '「作業日報」で作業内容を報告',
      '工程表（ガント）でスケジュールを可視化',
    ],
  },
  {
    title: '写真台帳・安全書類',
    icon: '📷',
    steps: [
      '「写真台帳」で現場写真を整理・台帳出力',
      '「安全書類」で安全関連書類を管理',
      'どちらもPDF出力に対応',
    ],
  },
  {
    title: '利益レポート・予実管理',
    icon: '📈',
    steps: [
      '「利益レポート」で売上・利益の推移を確認',
      '「予実管理」で予算と実績の差異を分析',
      'グラフで視覚的に経営状況を把握',
    ],
  },
  {
    title: '困ったときは',
    icon: '💡',
    steps: [
      '左メニューの「改善要望」からご連絡ください',
      '使い方のご質問・不具合報告・機能リクエストなど何でもOK',
      'いただいたご意見はサービス改善に直結します',
    ],
  },
];

export default function GuidePage() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>操作説明書</h1>
      <p style={{ textAlign: 'center', fontSize: 14, color: '#888', marginBottom: 32 }}>
        各機能の基本的な使い方をご案内します
      </p>

      {sections.map((sec, i) => (
        <div key={i} style={{
          marginBottom: 12,
          border: '1px solid #e0e0e0',
          borderRadius: 12,
          overflow: 'hidden',
          background: openIndex === i ? '#f8fbff' : '#fff',
          transition: 'background 0.2s',
        }}>
          <div
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
            style={{
              padding: '16px 20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontWeight: 'bold',
              fontSize: 16,
              userSelect: 'none',
            }}
          >
            <span style={{ fontSize: 24 }}>{sec.icon}</span>
            <span style={{ flex: 1 }}>{sec.title}</span>
            <span style={{ fontSize: 18, color: '#aaa', transition: 'transform 0.2s', transform: openIndex === i ? 'rotate(180deg)' : 'rotate(0deg)' }}>
              ▼
            </span>
          </div>
          {openIndex === i && (
            <div style={{ padding: '0 20px 20px 56px' }}>
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {sec.steps.map((step, j) => (
                  <li key={j} style={{
                    fontSize: 14,
                    lineHeight: 2,
                    color: '#444',
                  }}>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      ))}

      <div style={{
        marginTop: 32,
        padding: 20,
        background: 'linear-gradient(135deg, #e8f4fd, #f0e6ff)',
        borderRadius: 12,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 8 }}>ポイント</div>
        <p style={{ fontSize: 14, color: '#555', lineHeight: 1.8, margin: 0 }}>
          AI見積は使えば使うほど精度が向上します。{'\n'}
          金額を修正するたびにAIが学習し、次回からより正確な見積を出します。
        </p>
      </div>
    </div>
  );
}
