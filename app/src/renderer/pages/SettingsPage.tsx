import React, { useEffect, useState } from 'react';
import { PageGuide } from '../components/PageGuide';

// Sub-components are at the bottom of this file

export default function SettingsPage() {
  const [config, setConfig] = useState<any>({ anthropicKey: '', openaiKey: '', dbPath: '', companyName: '', companyAddress: '', companyTel: '', companyBank: '', invoiceNumber: '' });
  const [saved, setSaved] = useState(false);
  const [dbMsg, setDbMsg] = useState('');
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [localIp, setLocalIp] = useState<string>('');

  useEffect(() => {
    (window as any).api.loadConfig().then((c: any) => setConfig(c));
    // トンネル状態確認
    (window as any).api.tunnelStatus?.().then((s: any) => {
      if (s?.active) setTunnelUrl(s.url);
    }).catch(() => {});
    (window as any).api.getLocalIp?.().then((ip: string) => {
      if (ip) setLocalIp(ip);
    }).catch(() => {});
  }, []);

  // ← PlanManagement component is rendered below

  const save = async () => {
    await (window as any).api.saveConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const selectDbFolder = async () => {
    const folder = await (window as any).api.selectDbPath();
    if (!folder) return;
    const newPath = await (window as any).api.setDbPath(folder);
    setConfig({ ...config, dbPath: newPath });
    setDbMsg('設定しました。アプリを再起動すると反映されます。');
  };

  const toggleTunnel = async () => {
    if (tunnelUrl) {
      await (window as any).api.stopTunnel();
      setTunnelUrl(null);
    } else {
      setTunnelLoading(true);
      try {
        const url = await (window as any).api.startTunnel();
        setTunnelUrl(url);
      } catch (e: any) {
        alert('トンネル接続に失敗しました: ' + (e.message || e));
      }
      setTunnelLoading(false);
    }
  };

  const qrUrl = tunnelUrl ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(tunnelUrl)}` : '';

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>設定</h1>
        <PageGuide pageKey="settings" steps={[
          { icon: '🏢', title: 'STEP 1：会社情報を設定', desc: '会社名・住所・電話番号・振込先を入力すると、請求書に自動反映されます。' },
          { icon: '🔑', title: 'STEP 2：APIキーを設定', desc: 'AI見積もり機能を利用するためのAPIキーを設定します。', sub: 'プランによってAIストック数が異なります' },
          { icon: '🏗️', title: 'STEP 3：業種を選択', desc: '業種を選択するとAI見積もりの相場データや材料マスタが最適化されます。' },
        ]} />
      </div>

      {/* プラン・AIストック管理 */}
      <PlanManagement />

      {/* 管理者用: プラン申請管理 */}
      <PlanAdmin />

      {/* 文字サイズ */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>🔤 文字サイズ</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap' }}>小</span>
          <input
            type="range" min="80" max="150" step="5"
            value={Math.round((config.fontScale || 1) * 100)}
            onChange={e => {
              const scale = parseInt(e.target.value) / 100;
              setConfig({ ...config, fontScale: scale });
              (window as any).api.setZoom(scale);
            }}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap' }}>大</span>
          <span style={{ fontSize: 14, fontWeight: 'bold', color: '#2c3e50', minWidth: 50, textAlign: 'center' }}>
            {Math.round((config.fontScale || 1) * 100)}%
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => {
            setConfig({ ...config, fontScale: 1 });
            (window as any).api.setZoom(1);
          }} style={{ fontSize: 11 }}>リセット</button>
        </div>
        <button className="btn btn-primary" onClick={save} style={{ marginTop: 12 }}>保存</button>
        {saved && <span style={{ color: '#27ae60', fontSize: 13, marginLeft: 8 }}>✓ 保存しました</span>}
      </div>

      {/* 業種選択 */}
      <div className="card" style={{ border: '2px solid #e67e22' }}>
        <h3 style={{ marginBottom: 12 }}>🏗️ 業種設定</h3>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>業種を選択すると、AI見積もりの相場データや材料マスタがその業種に最適化されます。</p>
        <div className="form-row">
          <div className="form-group">
            <label>業種</label>
            <select value={config.industryType || 'general'} onChange={e => setConfig({ ...config, industryType: e.target.value })} style={{ fontSize: 15, padding: '8px 12px' }}>
              <option value="general">総合建設業（工務店・リフォーム）</option>
              <option value="lease">仮設工事リース業</option>
              <option value="demolition">解体工事業</option>
              <option value="exterior">外構・エクステリア業</option>
              <option value="painting">塗装工事業</option>
              <option value="equipment">設備工事業（水道・電気・空調）</option>
            </select>
          </div>
        </div>
        {config.industryType === 'lease' && (
          <div style={{ background: '#fef9e7', border: '1px solid #f39c12', borderRadius: 8, padding: 12, marginTop: 8, fontSize: 13 }}>
            <strong>仮設工事リース業モード:</strong> 足場・養生・仮囲い・仮設建物・重機・運搬の詳細な相場データでAI見積もりを行います。リース日数・月額ベースの見積もりに対応。
          </div>
        )}
        <button className="btn btn-primary" onClick={save} style={{ marginTop: 12 }}>保存</button>
        {saved && <span style={{ color: '#27ae60', fontSize: 13, marginLeft: 8 }}>✓ 保存しました</span>}
      </div>

      {/* 会社情報 */}
      <div className="card" style={{ border: '2px solid #27ae60' }}>
        <h3 style={{ marginBottom: 12 }}>🏢 会社情報（請求書に反映）</h3>
        <div className="form-row">
          <div className="form-group">
            <label>会社名</label>
            <input value={config.companyName || ''} onChange={e => setConfig({ ...config, companyName: e.target.value })} placeholder="例: 株式会社○○建設" />
          </div>
          <div className="form-group">
            <label>電話番号</label>
            <input value={config.companyTel || ''} onChange={e => setConfig({ ...config, companyTel: e.target.value })} placeholder="例: 06-1234-5678" />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>住所</label>
            <input value={config.companyAddress || ''} onChange={e => setConfig({ ...config, companyAddress: e.target.value })} placeholder="例: 大阪府大阪市中央区..." />
          </div>
          <div className="form-group">
            <label>メールアドレス（連絡先）</label>
            <input type="email" value={config.contactEmail || ''} onChange={e => setConfig({ ...config, contactEmail: e.target.value })} placeholder="例: info@example.com" />
          </div>
        </div>
        <div className="form-group">
          <label>自社の振込先（お客様への請求書に表示）</label>
          <div style={{ background: '#f8f9fa', border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <div className="form-row">
              <div className="form-group">
                <label>銀行名</label>
                <input value={config.myBankName || ''} onChange={e => setConfig({ ...config, myBankName: e.target.value })} placeholder="例: 三井住友銀行" />
              </div>
              <div className="form-group">
                <label>支店名</label>
                <input value={config.myBankBranch || ''} onChange={e => setConfig({ ...config, myBankBranch: e.target.value })} placeholder="例: 梅田支店" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>口座種別</label>
                <select value={config.myBankType || '普通'} onChange={e => setConfig({ ...config, myBankType: e.target.value })}>
                  <option value="普通">普通</option>
                  <option value="当座">当座</option>
                </select>
              </div>
              <div className="form-group">
                <label>口座番号</label>
                <input value={config.myBankNumber || ''} onChange={e => setConfig({ ...config, myBankNumber: e.target.value })} placeholder="例: 1234567" />
              </div>
            </div>
            <div className="form-group">
              <label>口座名義（カナ）</label>
              <input value={config.myBankHolder || ''} onChange={e => setConfig({ ...config, myBankHolder: e.target.value })} placeholder="例: カ）○○ケンセツ" />
            </div>
          </div>
        </div>
        <div className="form-group">
          <label>インボイス登録番号</label>
          <input value={config.invoiceNumber || ''} onChange={e => setConfig({ ...config, invoiceNumber: e.target.value })} placeholder="T-1234567890123" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>会社印（角印・丸印）</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={async () => {
                const img = await window.api.selectImage();
                if (img) { setConfig({ ...config, companySeal: img }); }
              }}>画像を選択</button>
              {config.companySeal && <button className="btn btn-sm btn-danger" onClick={() => setConfig({ ...config, companySeal: '' })}>削除</button>}
            </div>
            {config.companySeal && (
              <img src={config.companySeal} style={{ marginTop: 8, maxWidth: 100, maxHeight: 100, border: '1px solid #ddd', borderRadius: 4 }} alt="会社印" />
            )}
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>PNG推奨（背景透過）。請求書・見積書の右上に表示されます。</div>
          </div>
          <div className="form-group">
            <label>会社ロゴ</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={async () => {
                const img = await window.api.selectImage();
                if (img) { setConfig({ ...config, companyLogo: img }); }
              }}>画像を選択</button>
              {config.companyLogo && <button className="btn btn-sm btn-danger" onClick={() => setConfig({ ...config, companyLogo: '' })}>削除</button>}
            </div>
            {config.companyLogo && (
              <img src={config.companyLogo} style={{ marginTop: 8, maxWidth: 120, maxHeight: 50, border: '1px solid #ddd', borderRadius: 4 }} alt="ロゴ" />
            )}
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>PNG推奨。会社名の横に表示されます。</div>
          </div>
        </div>
        <button className="btn btn-primary" onClick={save}>保存</button>
        {saved && <span style={{ color: '#27ae60', fontSize: 13, marginLeft: 8 }}>✓ 保存しました</span>}
      </div>

      {/* スマホアクセス — ローカルIP */}
      {localIp && (
        <div className="card" style={{ border: '2px solid #3498db' }}>
          <h3 style={{ marginBottom: 8 }}>📱 スマホからアクセス（同一Wi-Fi）</h3>
          <p style={{ color: '#666', fontSize: 12, marginBottom: 8 }}>同じWi-Fiに接続されたスマホのブラウザで以下のURLを開いてください：</p>
          <div style={{
            background: '#f0f7ff', border: '2px solid #3498db', borderRadius: 8,
            padding: '10px 16px', fontSize: 16, fontWeight: 'bold', color: '#3498db',
            cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}
            onClick={() => { navigator.clipboard.writeText(`http://${localIp}:3456`); alert('URLをコピーしました'); }}
          >
            <span>http://{localIp}:3456</span>
            <span style={{ fontSize: 11, fontWeight: 'normal', color: '#888' }}>クリックでコピー</span>
          </div>
          <div style={{ marginTop: 8, textAlign: 'center' }}>
            <img src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(`http://${localIp}:3456`)}`} alt="QR" style={{ width: 120, height: 120, borderRadius: 8, border: '1px solid #ddd' }} />
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>QRコードで即アクセス</div>
          </div>
        </div>
      )}

      {/* 外出先アクセス */}
      <div className="card" style={{ border: '2px solid #e67e22', background: tunnelUrl ? '#fffbf0' : '#fff' }}>
        <h3 style={{ marginBottom: 12 }}>🌐 外出先からアクセス</h3>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 16 }}>
          ONにすると、外出先のスマホやPCからインターネット経由でこのアプリにアクセスできます。<br/>
          現場で写真を撮ってそのままAI見積もりに送れます。
        </p>

        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <button
              className={tunnelUrl ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={toggleTunnel}
              disabled={tunnelLoading}
              style={{ fontSize: 16, padding: '12px 32px' }}
            >
              {tunnelLoading ? '⏳ 接続中...' : tunnelUrl ? '🔴 外部公開を停止' : '🌐 外部公開を開始'}
            </button>

            {tunnelUrl && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>スマホでこのURLを開く：</div>
                <div style={{
                  background: '#fff', border: '2px solid #e67e22', borderRadius: 8,
                  padding: '10px 16px', fontSize: 16, fontWeight: 'bold', color: '#e67e22',
                  wordBreak: 'break-all', cursor: 'pointer',
                }}
                  onClick={() => { navigator.clipboard.writeText(tunnelUrl); alert('URLをコピーしました'); }}
                >
                  {tunnelUrl}
                  <span style={{ fontSize: 11, fontWeight: 'normal', marginLeft: 8, color: '#888' }}>（クリックでコピー）</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
                  ※ 初回アクセス時に確認画面が出る場合は「Click to Continue」を押してください
                </div>
              </div>
            )}
          </div>

          {tunnelUrl && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>QRコードで即アクセス</div>
              <img src={qrUrl} alt="QR" style={{ width: 160, height: 160, borderRadius: 8, border: '1px solid #ddd' }} />
              <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>スマホのカメラで読み取り</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="form-group">
            <label>アクセスパスワード（空欄=パスワードなし）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="password" value={config.serverPassword || ''} onChange={e => setConfig({ ...config, serverPassword: e.target.value })} placeholder="外部アクセス時のパスワード" style={{ flex: 1 }} />
              <button className="btn btn-secondary" onClick={save}>設定</button>
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>設定するとURL接続時にパスワード入力が必要になります</div>
          </div>
        </div>

        {!tunnelUrl && (
          <div style={{ background: '#f8f9fa', padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.8, marginTop: 12 }}>
            <strong>使い方：</strong><br/>
            ① 「外部公開を開始」ボタンを押す<br/>
            ② 表示されたURLまたはQRコードをスマホで開く<br/>
            ③ 現場で写真を撮影 → AI見積もりページにアップロード<br/>
            ④ 帰ったら「外部公開を停止」で安全に閉じる
          </div>
        )}
      </div>

      {/* データ共有設定 */}
      <div className="card" style={{ marginTop: 16, border: '2px solid #3a7bd5' }}>
        <h3 style={{ marginBottom: 12 }}>📂 データ共有設定</h3>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
          OneDrive・Google Drive・共有フォルダにデータベースを置くと、複数PCで同じデータを共有できます。
        </p>
        <div className="form-group">
          <label>データベース保存先</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={config.dbPath || '（デフォルト: ローカル）'} readOnly style={{ flex: 1, background: '#f8f9fa', cursor: 'default' }} />
            <button className="btn btn-primary" onClick={selectDbFolder}>フォルダを選択</button>
          </div>
          {dbMsg && <div style={{ color: '#e67e22', fontSize: 12, marginTop: 6 }}>{dbMsg}</div>}
        </div>
      </div>

      {/* API キー設定は非表示（トライアル版では埋め込み済み） */}

      {/* CSVエクスポート */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 12 }}>📤 データエクスポート</h3>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>CSV形式でエクスポートします。Excelや会計ソフトに取り込めます。</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={() => (window as any).api.exportConstructions()}>施工データ CSV</button>
          <button className="btn btn-secondary" onClick={() => (window as any).api.exportInvoices()}>請求書データ CSV</button>
          <button className="btn btn-secondary" onClick={() => (window as any).api.exportMaterials()}>材料マスタ CSV</button>
          <button className="btn btn-primary" onClick={async () => {
            try {
              const r = await (window as any).api.batchExportPDF();
              if (!r) return;
              if (r.canceled) return;
              if (r.success) alert(`請求書PDFを${r.count}件出力しました（保存先を開きます）`);
              else alert(r.message || '出力する請求書がありませんでした');
            } catch (e: any) { alert('一括出力に失敗しました: ' + (e?.message || e)); }
          }}>請求書PDF一括出力</button>
        </div>
      </div>

      {/* データ連携 */}
      <DataTransfer />

      {/* ユーザー管理 */}
      <UserManagement />

      {/* 監査ログ */}
      <AuditLog />
    </div>
  );
}

function PlanManagement() {
  const [planInfo, setPlanInfo] = useState<any>(null);
  const [plans, setPlans] = useState<any>({});
  const [costs, setCosts] = useState<any>({});
  const [creditLog, setCreditLog] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [showCosts, setShowCosts] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const [p, pl, c, reqs] = await Promise.all([
      (window as any).api.getPlan(),
      (window as any).api.listPlans(),
      (window as any).api.getCreditCosts(),
      (window as any).api.listPlanRequests(),
    ]);
    setPlanInfo(p);
    setPlans(pl);
    setCosts(c);
    setRequests(reqs || []);
  };

  const loadLog = async () => {
    const log = await (window as any).api.getCreditLog();
    setCreditLog(log);
    setShowLog(true);
  };

  const STRIPE_LINKS: Record<string, string> = {
    standard: 'https://buy.stripe.com/dRmaEYadJ3h95rP9MO24003',
    pro: 'https://buy.stripe.com/bJe7sMfy36tl7zX0ce24005',
  };

  const requestPlan = async (planKey: string) => {
    try {
      // プラン申請を記録 + メール通知を送信
      await (window as any).api.requestPlan(planKey);
    } catch (_) { /* 通知失敗しても続行 */ }

    const link = STRIPE_LINKS[planKey];
    if (link) {
      window.open(link, '_blank');
    } else {
      // 法人カスタム等: 申請送信済み
      alert('お問い合わせを送信しました。担当者からご連絡いたします。');
    }
  };

  if (!planInfo) return null;

  const usagePercent = planInfo.limit > 0 ? Math.min(100, Math.round((planInfo.used / planInfo.limit) * 100)) : 0;
  const barColor = usagePercent >= 90 ? '#e74c3c' : usagePercent >= 70 ? '#f39c12' : '#27ae60';
  const isNearLimit = usagePercent >= 80;
  const hasPendingRequest = requests.some((r: any) => r.status === 'pending');

  const statusLabel: Record<string, { text: string; color: string }> = {
    pending:   { text: '入金待ち', color: '#f39c12' },
    approved:  { text: '承認済み', color: '#27ae60' },
    rejected:  { text: '却下',     color: '#e74c3c' },
    cancelled: { text: 'キャンセル', color: '#888' },
  };

  return (
    <div className="card" style={{ border: '2px solid #2c3e50', background: isNearLimit ? '#fff5f5' : '#fff' }}>
      <h3 style={{ marginBottom: 16 }}>📊 AIストック・プラン管理</h3>

      {/* 現在のプラン & 使用状況 */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>現在のプラン</div>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: '#2c3e50' }}>
            {planInfo.planName}
            <span style={{ fontSize: 14, fontWeight: 'normal', color: '#888', marginLeft: 8 }}>
              ¥{(planInfo.price || 0).toLocaleString()}/年（税込）
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{planInfo.description}</div>
        </div>

        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>今月のAIストック使用量</div>
          <div style={{ fontSize: 20, fontWeight: 'bold', color: barColor }}>
            {planInfo.used} <span style={{ fontSize: 14, fontWeight: 'normal', color: '#888' }}>/ {planInfo.limit} 単位</span>
            <span style={{ fontSize: 14, fontWeight: 'normal', marginLeft: 8, color: barColor }}>
              （残り {planInfo.remaining} 単位）
            </span>
          </div>
          {/* プログレスバー */}
          <div style={{ background: '#ecf0f1', borderRadius: 8, height: 12, marginTop: 8, overflow: 'hidden' }}>
            <div style={{ background: barColor, height: '100%', width: `${usagePercent}%`, borderRadius: 8, transition: 'width 0.3s' }} />
          </div>
          <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>{usagePercent}% 使用済み</div>
        </div>
      </div>

      {/* 上限警告 */}
      {isNearLimit && (
        <div style={{
          background: usagePercent >= 100 ? '#e74c3c' : '#f39c12',
          color: '#fff', padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13,
        }}>
          {usagePercent >= 100
            ? planInfo.plan === 'trial'
              ? '🎁 クレジットを使い切りました。引き続きご利用いただくにはプランのアップグレードが必要です。下記プランからお選びください。'
              : '⚠️ 今月のAIストックの上限に達しました。追加ストックが必要な場合は管理者にお問い合わせください。'
            : planInfo.plan === 'trial'
              ? `🎁 残りクレジット: ${planInfo.remaining}単位`
              : '⚠️ AIストックの残りが少なくなっています。'}
        </div>
      )}

      {/* ストック消費量の説明 */}
      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setShowCosts(!showCosts)}>
          {showCosts ? '▼' : '▶'} 操作ごとのストック消費量
        </button>
        {showCosts && (
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead><tr><th>操作</th><th style={{ textAlign: 'center' }}>消費ストック</th></tr></thead>
            <tbody>
              {Object.entries(costs).map(([op, cost]: [string, any]) => (
                <tr key={op}>
                  <td>{op}</td>
                  <td style={{ textAlign: 'center', fontWeight: 'bold', color: cost === 0 ? '#27ae60' : '#333' }}>
                    {cost === 0 ? '無料' : cost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* プラン一覧 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>料金プラン</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {Object.entries(plans).map(([key, p]: [string, any]) => {
            const isCurrent = key === planInfo.plan;
            const isUpgrade = p.price > (planInfo.price || 0);
            const canRequest = !isCurrent && !hasPendingRequest && key !== 'enterprise';
            return (
              <div key={key} style={{
                flex: '1 1 180px', border: isCurrent ? '2px solid #3a7bd5' : '1px solid #ddd',
                borderRadius: 8, padding: 16, background: isCurrent ? '#f0f7ff' : '#fff',
                textAlign: 'center', position: 'relative',
                cursor: canRequest ? 'pointer' : 'default',
                transition: 'transform 0.15s, box-shadow 0.15s',
              }}
                onMouseEnter={e => { if (canRequest) { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; } }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.boxShadow = ''; }}
              >
                {isCurrent && (
                  <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)',
                    background: '#3a7bd5', color: '#fff', fontSize: 10, padding: '2px 10px', borderRadius: 10 }}>
                    現在のプラン
                  </div>
                )}
                <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 4 }}>{p.name}</div>
                <div style={{ fontSize: 20, fontWeight: 'bold', color: key === 'trial' ? '#27ae60' : '#2c3e50', marginBottom: 4 }}>
                  {key === 'trial' ? '無料' : `¥${p.price.toLocaleString()}`}
                  <span style={{ fontSize: 11, fontWeight: 'normal' }}>/年</span>
                </div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                  月 {key === 'enterprise' ? '個別設定' : p.monthlyLimit + '単位'}
                </div>
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 8 }}>{p.description}</div>
                {canRequest && (
                  <button
                    className={`btn btn-sm ${isUpgrade ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => requestPlan(key)}
                    disabled={requesting}
                    style={{ width: '100%' }}
                  >
                    {isUpgrade ? '申し込む' : 'プラン変更'}
                  </button>
                )}
                {key === 'enterprise' && !isCurrent && (
                  <div style={{ fontSize: 11, color: '#3a7bd5', marginTop: 4 }}>お問い合わせください</div>
                )}
              </div>
            );
          })}
        </div>
        {hasPendingRequest && (
          <div style={{ fontSize: 12, color: '#f39c12', marginTop: 8, fontWeight: 'bold' }}>
            ※ プラン変更申請中です。入金確認後にプランが切り替わります。
          </div>
        )}
      </div>

      {/* 申請履歴 */}
      {requests.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>プラン申請履歴</div>
          <table className="data-table">
            <thead><tr><th>申請日</th><th>プラン</th><th>金額</th><th>請求番号</th><th>ステータス</th><th></th></tr></thead>
            <tbody>
              {requests.map((r: any) => {
                const st = statusLabel[r.status] || { text: r.status, color: '#888' };
                return (
                  <tr key={r.id}>
                    <td style={{ fontSize: 11 }}>{r.created_at?.split(' ')[0]}</td>
                    <td><strong>{plans[r.requested_plan]?.name || r.requested_plan}</strong></td>
                    <td>¥{(r.price || 0).toLocaleString()}</td>
                    <td style={{ fontSize: 11 }}>{r.invoice_number}</td>
                    <td><span style={{ color: st.color, fontWeight: 'bold', fontSize: 12 }}>{st.text}</span></td>
                    <td>
                      {r.status === 'pending' && (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-sm btn-secondary" onClick={async () => {
                            await (window as any).api.generatePlanInvoice(r.id);
                          }}>請求書PDF</button>
                          <button className="btn btn-sm btn-danger" onClick={async () => {
                            if (!confirm('この申請をキャンセルしますか？')) return;
                            await (window as any).api.cancelPlanRequest(r.id);
                            await load();
                          }}>キャンセル</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 利用履歴 */}
      <div>
        <button className="btn btn-sm btn-secondary" onClick={loadLog}>
          {showLog ? '更新' : '利用履歴を表示'}
        </button>
        {showLog && creditLog.length > 0 && (
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead><tr><th>日時</th><th>操作</th><th style={{ textAlign: 'center' }}>消費</th></tr></thead>
            <tbody>
              {creditLog.slice(0, 30).map((l: any) => (
                <tr key={l.id}>
                  <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{l.created_at}</td>
                  <td>{l.operation}</td>
                  <td style={{ textAlign: 'center', fontWeight: 'bold', color: l.amount < 0 ? '#e74c3c' : '#27ae60' }}>
                    {l.amount < 0 ? Math.abs(l.amount) : '+' + l.amount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PlanAdmin() {
  const [isOwner, setIsOwner] = useState(false);
  const [tenants, setTenants] = useState<any[]>([]);
  const [plans, setPlans] = useState<any>({});
  const [msg, setMsg] = useState('');

  useEffect(() => {
    (window as any).api.currentTenant?.().then((tid: number) => {
      if (tid === 1) {
        setIsOwner(true);
        load();
      }
    }).catch(() => {});
  }, []);

  const load = async () => {
    const [t, pl] = await Promise.all([
      (window as any).api.listTenants(),
      (window as any).api.listPlans(),
    ]);
    setTenants(t.filter((x: any) => x.id > 1));
    setPlans(pl);
  };

  const changePlan = async (tenantId: number, tenantName: string, newPlan: string) => {
    const planDef = plans[newPlan];
    if (!planDef) return;
    if (!confirm(`「${tenantName}」のプランを「${planDef.name}（¥${planDef.price.toLocaleString()}/年）」に変更しますか？\n\n入金確認済みの場合のみ実行してください。`)) return;
    try {
      await (window as any).api.setPlan(newPlan, tenantId);
      setMsg(`${tenantName} → ${planDef.name}プランに変更しました`);
      await load();
      setTimeout(() => setMsg(''), 3000);
    } catch (e: any) { setMsg('エラー: ' + (e.message || e)); }
  };

  if (!isOwner) return null;
  if (tenants.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: 16, border: '2px solid #e67e22' }}>
      <h3 style={{ marginBottom: 12 }}>🔑 テナント プラン管理（管理者）</h3>
      <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
        入金確認後、テナントのプランを変更してください。
      </p>
      {msg && <div style={{ background: msg.startsWith('エラー') ? '#fdecea' : '#e8f8f0', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13, color: msg.startsWith('エラー') ? '#c0392b' : '#27ae60' }}>{msg}</div>}
      <table className="data-table">
        <thead>
          <tr><th>テナント</th><th>現在のプラン</th><th>プラン変更</th></tr>
        </thead>
        <tbody>
          {tenants.map((t: any) => {
            const currentPlan = plans[t.plan] || { name: t.plan || '未設定' };
            return (
              <tr key={t.id}>
                <td><strong>{t.name}</strong></td>
                <td>
                  <span style={{ background: '#f0f7ff', color: '#3a7bd5', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 'bold' }}>
                    {currentPlan.name}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {Object.entries(plans).filter(([k]) => k !== t.plan && k !== 'enterprise').map(([key, p]: [string, any]) => (
                      <button key={key} className="btn btn-sm btn-primary" onClick={() => changePlan(t.id, t.name, key)}>
                        {p.name}に変更
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DataTransfer() {
  const [isOwner, setIsOwner] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    (window as any).api.currentTenant?.().then((tid: number) => {
      if (tid === 1) setIsOwner(true);
    }).catch(() => {});
  }, []);

  if (!isOwner) return null;

  const exportData = async () => {
    setMsg('');
    try {
      const result = await (window as any).api.exportData();
      if (result.success) setMsg('エクスポート完了: ' + result.path);
    } catch (e: any) { setMsg('エラー: ' + (e.message || e)); }
  };

  const importData = async () => {
    setMsg('');
    try {
      const result = await (window as any).api.importData();
      if (result.success) {
        const i = result.imported;
        setMsg(`「${result.tenantName}」のデータを取り込みました — 物件${i.properties}件 材料${i.materials}件 施工${i.constructions}件 請求書${i.invoices}件 写真${i.photos}件`);
      }
    } catch (e: any) { setMsg('エラー: ' + (e.message || e)); }
  };

  return (
    <div className="card" style={{ marginTop: 16, border: '2px solid #8e44ad' }}>
      <h3 style={{ marginBottom: 12 }}>🔄 データ連携</h3>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
        他拠点のデータを取り込めます。材料マスタは名前・カテゴリが一致すれば単価を更新、なければ新規追加します。
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={importData}>データを取り込み</button>
        <button className="btn btn-secondary" onClick={exportData}>データをエクスポート</button>
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 13, color: msg.startsWith('エラー') ? '#c0392b' : '#27ae60', whiteSpace: 'pre-wrap' }}>{msg}</div>}
    </div>
  );
}

function UserManagement() {
  const [isOwner, setIsOwner] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [form, setForm] = useState({ username: '', password: '', role: 'user' });
  const [msg, setMsg] = useState('');
  const [showAddTenant, setShowAddTenant] = useState(false);
  const [tenantForm, setTenantForm] = useState({ companyName: '', plan: 'demo', credits: 30, username: '', password: '' });
  const [tenantMsg, setTenantMsg] = useState('');
  const [tenantLoading, setTenantLoading] = useState(false);

  const plans: Record<string, { name: string; credits: number }> = {
    demo: { name: 'デモ', credits: 30 },
    standard: { name: 'スタンダード', credits: 50 },
    pro: { name: 'プロ', credits: 300 },
    enterprise: { name: '法人カスタム', credits: 9999 },
  };

  useEffect(() => {
    (window as any).api.currentTenant?.().then((tid: number) => {
      if (tid === 1) { setIsOwner(true); load(); }
    }).catch(() => {});
  }, []);
  const load = async () => {
    setUsers(await (window as any).api.listUsers());
    setTenants(await (window as any).api.listTenants());
  };

  if (!isOwner) return null;

  const create = async () => {
    if (!form.username || !form.password) { setMsg('ユーザー名とパスワードを入力'); return; }
    try {
      await (window as any).api.createUser(form);
      setForm({ username: '', password: '', role: 'user' });
      setMsg('');
      load();
    } catch (e: any) { setMsg(e.message || 'エラー'); }
  };

  const remove = async (id: number) => {
    if (confirm('削除しますか？')) { await (window as any).api.deleteUser(id); load(); }
  };

  const addTenant = async () => {
    if (!tenantForm.companyName.trim()) { setTenantMsg('会社名を入力してください'); return; }
    if (!tenantForm.username.trim() || !tenantForm.password) { setTenantMsg('ユーザー名とパスワードを入力してください'); return; }
    setTenantLoading(true);
    setTenantMsg('');
    try {
      // 1. テナント作成
      const tenantId = await (window as any).api.createTenant(tenantForm.companyName.trim());
      // 2. プラン・クレジット設定
      await (window as any).api.setPlan(tenantForm.plan, tenantId);
      await (window as any).api.setTenantCredits(tenantId, tenantForm.credits);
      // 3. ユーザー作成（テナントに紐づけ）
      await (window as any).api.createUser({
        username: tenantForm.username.trim(),
        password: tenantForm.password,
        role: 'admin',
        tenantId,
      });
      setTenantMsg(`「${tenantForm.companyName}」を追加しました（${plans[tenantForm.plan]?.name}プラン / ${tenantForm.credits}単位）`);
      setTenantForm({ companyName: '', plan: 'demo', credits: 30, username: '', password: '' });
      load();
    } catch (e: any) { setTenantMsg('エラー: ' + (e.message || '作成に失敗しました')); }
    setTenantLoading(false);
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginBottom: 12 }}>👥 ユーザー・テナント管理</h3>

      {/* テナント一覧 */}
      {tenants.length > 1 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>登録テナント</div>
          <table className="data-table" style={{ marginBottom: 8 }}>
            <thead><tr><th>会社名</th><th>プラン</th><th>クレジット</th><th>ステータス</th></tr></thead>
            <tbody>
              {tenants.filter((t: any) => t.id > 1).map((t: any) => (
                <tr key={t.id}>
                  <td><strong>{t.contact_company || t.name}</strong></td>
                  <td><span className="badge badge-draft">{plans[t.plan]?.name || t.plan}</span></td>
                  <td>{t.credits ?? '-'} / {t.plan_limit ?? '-'}</td>
                  <td>
                    <span className={`badge ${t.plan === 'suspended' ? 'badge-overdue' : 'badge-paid'}`}>
                      {t.plan === 'suspended' ? '停止中' : '有効'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* テナント追加 */}
      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-sm btn-primary" onClick={() => setShowAddTenant(!showAddTenant)} style={{ marginBottom: 8 }}>
          {showAddTenant ? '▲ 閉じる' : '＋ 新規テナント（顧客）を追加'}
        </button>
        {showAddTenant && (
          <div style={{ background: '#f8f9fa', border: '1px solid #e0e0e0', borderRadius: 8, padding: 16 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label>会社名</label>
              <input value={tenantForm.companyName} onChange={e => setTenantForm({ ...tenantForm, companyName: e.target.value })} placeholder="株式会社○○" style={{ width: '100%' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>プラン</label>
                <select value={tenantForm.plan} onChange={e => {
                  const p = e.target.value;
                  setTenantForm({ ...tenantForm, plan: p, credits: plans[p]?.credits || 20 });
                }}>
                  <option value="demo">デモ（30単位）</option>
                  <option value="standard">スタンダード（50単位/月）</option>
                  <option value="pro">プロ（200単位/月）</option>
                  <option value="enterprise">法人カスタム</option>
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>クレジット数</label>
                <input type="number" value={tenantForm.credits} onChange={e => setTenantForm({ ...tenantForm, credits: parseInt(e.target.value) || 0 })} />
              </div>
            </div>
            <div style={{ fontSize: 12, fontWeight: 'bold', color: '#555', marginBottom: 6, borderTop: '1px solid #ddd', paddingTop: 8 }}>初期管理者アカウント</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>ユーザー名</label>
                <input value={tenantForm.username} onChange={e => setTenantForm({ ...tenantForm, username: e.target.value })} placeholder="ログイン用" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>パスワード</label>
                <input type="password" value={tenantForm.password} onChange={e => setTenantForm({ ...tenantForm, password: e.target.value })} />
              </div>
            </div>
            <button className="btn btn-primary" onClick={addTenant} disabled={tenantLoading} style={{ marginTop: 4 }}>
              {tenantLoading ? '作成中...' : 'テナントを作成'}
            </button>
            {tenantMsg && <div style={{ marginTop: 6, fontSize: 12, color: tenantMsg.startsWith('エラー') ? '#c0392b' : '#27ae60' }}>{tenantMsg}</div>}
          </div>
        )}
      </div>

      {/* 既存ユーザー一覧 */}
      <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 6 }}>ユーザー一覧</div>
      {users.length > 0 && (
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead><tr><th>ユーザー名</th><th>権限</th><th>作成日</th><th></th></tr></thead>
          <tbody>
            {users.map((u: any) => (
              <tr key={u.id}>
                <td><strong>{u.username}</strong></td>
                <td><span className={`badge ${u.role === 'admin' ? 'badge-paid' : 'badge-draft'}`}>{u.role}</span></td>
                <td style={{ fontSize: 12 }}>{u.created_at?.split(' ')[0]}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => remove(u.id)}>削除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>ユーザー名</label>
          <input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="username" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>パスワード</label>
          <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>権限</label>
          <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
            <option value="admin">管理者</option>
            <option value="user">一般</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={create} style={{ height: 36 }}>追加</button>
      </div>
      {msg && <div style={{ color: '#c0392b', fontSize: 12, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function AuditLog() {
  const [isOwner, setIsOwner] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [show, setShow] = useState(false);

  useEffect(() => {
    (window as any).api.currentTenant?.().then((tid: number) => {
      if (tid === 1) setIsOwner(true);
    }).catch(() => {});
  }, []);

  if (!isOwner) return null;

  const load = async () => {
    setLogs(await (window as any).api.listAuditLog());
    setShow(true);
  };

  const actionLabel: any = { create: '作成', update: '更新', delete: '削除' };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>📋 監査ログ</h3>
        <button className="btn btn-sm btn-secondary" onClick={load}>{show ? '更新' : '表示'}</button>
      </div>
      {show && logs.length > 0 && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>日時</th><th>操作</th><th>対象</th><th>詳細</th></tr></thead>
          <tbody>
            {logs.slice(0, 30).map((l: any) => (
              <tr key={l.id}>
                <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{l.created_at}</td>
                <td><span className={`badge badge-${l.action === 'delete' ? 'overdue' : l.action === 'create' ? 'paid' : 'sent'}`}>{actionLabel[l.action] || l.action}</span></td>
                <td>{l.entity} #{l.entity_id}</td>
                <td style={{ fontSize: 12, color: '#666' }}>{l.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
