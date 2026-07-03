import React from 'react';

export default function TermsPage() {
  const sectionStyle: React.CSSProperties = { marginBottom: 28 };
  const h2Style: React.CSSProperties = { fontSize: 17, fontWeight: 'bold', marginBottom: 10, borderBottom: '2px solid #3a7bd5', paddingBottom: 6 };
  const pStyle: React.CSSProperties = { fontSize: 14, lineHeight: 1.9, color: '#444', whiteSpace: 'pre-wrap' };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>建築ブースト 利用規約</h1>
      <p style={{ textAlign: 'center', fontSize: 13, color: '#888', marginBottom: 32 }}>最終更新日: 2026年6月23日</p>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第1条（適用）</h2>
        <p style={pStyle}>本規約は、建築ブースト（以下「本サービス」）の利用条件を定めるものです。ユーザーは本規約に同意の上、本サービスをご利用ください。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第2条（定義）</h2>
        <p style={pStyle}>1. 「本サービス」とは、AI を活用した建築見積作成・施工管理・請求書管理等の機能を提供するデスクトップアプリケーションを指します。{'\n'}2. 「ユーザー」とは、本サービスの利用者（法人・個人事業主を含む）を指します。{'\n'}3. 「テナント」とは、ユーザーが本サービス上で管理する企業・事業単位を指します。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第3条（アカウント）</h2>
        <p style={pStyle}>1. ユーザーは正確な情報を登録し、アカウント情報を適切に管理する責任を負います。{'\n'}2. アカウントの第三者への譲渡・貸与は禁止します。{'\n'}3. パスワードの管理不備による損害について、当社は責任を負いません。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第4条（サービス内容）</h2>
        <p style={pStyle}>1. 本サービスは、AI による見積金額の自動算出、施工管理、請求書・発注書の作成、写真台帳の管理等の機能を提供します。{'\n'}2. AI による見積金額は参考値であり、最終的な金額判断はユーザーの責任で行ってください。{'\n'}3. 当社はサービスの改善のため、予告なく機能の追加・変更・廃止を行うことがあります。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第5条（料金・支払い）</h2>
        <p style={pStyle}>1. 本サービスの料金プランは別途定めるとおりとします。{'\n'}2. 有料プランの料金は、所定の方法により毎月お支払いいただきます。{'\n'}3. お支払い済みの料金は、法令に定める場合を除き、返金いたしません。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第6条（禁止事項）</h2>
        <p style={pStyle}>ユーザーは以下の行為を行ってはなりません。{'\n'}1. 本サービスの不正利用、リバースエンジニアリング{'\n'}2. 他のユーザーへの迷惑行為{'\n'}3. 虚偽の情報の登録{'\n'}4. 本サービスのサーバーへの過度な負荷をかける行為{'\n'}5. 法令または公序良俗に反する行為{'\n'}6. 本サービスで取得した情報の無断転載・再配布</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第7条（データの取り扱い）</h2>
        <p style={pStyle}>1. ユーザーが入力したデータの所有権はユーザーに帰属します。{'\n'}2. 当社は、サービス改善（AI 精度向上を含む）のため、匿名化・統計化したデータを利用することがあります。個別案件を特定できる形での利用は行いません。{'\n'}3. データのバックアップはユーザーの責任で行ってください。当社は合理的な範囲でデータ保全に努めますが、完全な保証はいたしません。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第8条（知的財産権）</h2>
        <p style={pStyle}>本サービスに関する知的財産権（特許権・著作権を含む）は当社に帰属します。ユーザーには、本規約に基づく利用権のみが付与されます。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第9条（免責事項）</h2>
        <p style={pStyle}>1. AI による見積結果の正確性・完全性を保証するものではありません。{'\n'}2. 本サービスの利用に起因する損害について、当社の故意・重過失による場合を除き、当社は責任を負いません。{'\n'}3. 通信障害・システム障害等による一時的なサービス停止について、当社は責任を負いません。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第10条（契約の解除）</h2>
        <p style={pStyle}>1. ユーザーは、所定の手続きによりいつでも本サービスの利用を終了できます。{'\n'}2. ユーザーが本規約に違反した場合、当社はサービスの提供を停止・解除できます。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第11条（規約の変更）</h2>
        <p style={pStyle}>当社は本規約を変更する場合、事前にアプリ内またはメールで通知します。変更後も本サービスを利用した場合、変更に同意したものとみなします。</p>
      </div>

      <div style={sectionStyle}>
        <h2 style={h2Style}>第12条（準拠法・管轄）</h2>
        <p style={pStyle}>本規約は日本法に準拠し、本サービスに関する紛争は、当社所在地を管轄する裁判所を第一審の専属的合意管轄裁判所とします。</p>
      </div>

      <div style={{ textAlign: 'center', marginTop: 40, padding: '20px', background: '#f8f9fa', borderRadius: 12, fontSize: 13, color: '#666' }}>
        ご不明点がございましたら、サイドバーの「改善要望」よりお問い合わせください。
      </div>
    </div>
  );
}
