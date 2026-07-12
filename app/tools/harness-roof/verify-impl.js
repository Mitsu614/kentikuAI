// 実装(main.ts)のプロンプト＋計算ロジックを、そのままベンチにかける
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const APP='C:/Users/mitsu/OneDrive/Desktop/kentikuAI/app';
const Anthropic=require(path.join(APP,'node_modules/@anthropic-ai/sdk'));
function apiKey(){const k=crypto.createHash('sha256').update(os.hostname()+os.userInfo().username+'kentiku-salt').digest();
 const c=JSON.parse(fs.readFileSync(process.env.APPDATA+'/kenchiku-boost/api-config.json','utf8'));const d=c.anthropicKey;
 if(!d.startsWith('enc:'))return d;const b=Buffer.from(d.slice(4),'base64');
 const dc=crypto.createDecipheriv('aes-256-gcm',k,b.subarray(0,12));dc.setAuthTag(b.subarray(12,28));
 return dc.update(b.subarray(28))+dc.final('utf8');}
const client=new Anthropic({apiKey:apiKey()});
const src=fs.readFileSync(path.join(APP,'src/main/main.ts'),'utf8');
// 実装の user テキストをそのまま組み立てる（ガイド3本を展開）
const g=n=>{const a=src.indexOf('const '+n+' = `')+('const '+n+' = `').length;
 const b=src.indexOf('`;',a); if(a<20||b<0) throw new Error('抽出失敗: '+n); return src.slice(a,b);};
const _i = src.indexOf('## まず、何を測るのかを決めろ');
const _j = src.indexOf('}`,', _i);
if (_i < 0 || _j < 0) throw new Error('実装のプロンプト部を抽出できません');
const BODY = src.slice(_i, _j + 1)
  .replace('${AREA_SCALE_GUIDE}', g('AREA_SCALE_GUIDE'))
  .replace('${WALL_SCALE_GUIDE}', g('WALL_SCALE_GUIDE'))
  .replace('${FLOOR_SCALE_GUIDE}', g('FLOOR_SCALE_GUIDE'));
// 屋根の基準値。テナントの実測が無い状態＝この値
const CAL=Number(src.match(/roof: ([\d.]+), wall:/)[1]);
console.log('AREA_CALIBRATION_BASE.roof =', CAL);

(async()=>{
 const ds=JSON.parse(fs.readFileSync('ds_truth.json','utf8'));
 const out=[];
 for(let i=0;i<ds.length;i+=4){
  const batch=ds.slice(i,i+4);
  const rs=await Promise.all(batch.map(async it=>{
   const buf=fs.readFileSync(it.file);
   const r=await client.messages.create({model:'claude-sonnet-4-6',max_tokens:1500,temperature:0,
    system:'あなたは建築の積算担当者です。写真から工事対象の面積・数量だけを推定します。金額は一切出しません。',
    messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:buf.toString('base64')}},
     {type:'text',text:`依頼内容: ${it.comment}\n\nこの写真の工事対象について、**寸法だけ**を答えてください。面積は計算しないでください（こちらで計算します）。\n\n${BODY}`}]}]});
   const j=JSON.parse(r.content[0].text.match(/\{[\s\S]*\}/)[0]);
   const w=Number(j.widthM)||0,l=Number(j.lengthM)||0;
   const sf=Number(j.slopeFactor)>0?Number(j.slopeFactor):1, df=Number(j.developFactor)>0?Number(j.developFactor):1;
   const q=w>0&&l>0?Math.round(w*l*CAL*sf*df*10)/10:null;
   return {id:it.id,truth:it.statedAreaM2,got:q,ratio:q?q/it.statedAreaM2:null,cover:j.coversWholeRoof,
     scale:`[${j.target}] `+(j.scaleRef||'').slice(0,34),view:it.viewType,target:j.target};
  }));
  out.push(...rs);
  for(const r of rs){const m=r.ratio>=0.8&&r.ratio<=1.25?'OK':r.ratio>=0.67&&r.ratio<=1.5?'△ ':'NG';
   console.log(`${r.id.padEnd(24)} ${m} 正解${String(r.truth).padStart(5)} 予測${String(r.got).padStart(7)} 比${(r.ratio||0).toFixed(2)} 全体${r.cover?'○':'×'} ${r.view} | ${r.scale}`);}
 }
 const ok=out.filter(r=>r.ratio);
 const med=a=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)];};
 const w=f=>ok.filter(r=>r.ratio>=1/f&&r.ratio<=f).length;
 const gm=Math.exp(ok.reduce((s,r)=>s+Math.log(r.ratio),0)/ok.length);
 const worst=ok.reduce((m,r)=>Math.max(m,Math.max(r.ratio,1/r.ratio)),0);
 console.log(`\n=== 実装の成績 (n=${ok.length}) ===`);
 console.log(`1.25倍以内 ${w(1.25)}件 / 1.5倍以内 ${w(1.5)}件 / 2倍以内 ${w(2)}件`);
 console.log(`|log比|中央 ${med(ok.map(r=>Math.abs(Math.log(r.ratio)))).toFixed(3)}  幾何平均比 ${gm.toFixed(2)}  最悪 ${worst.toFixed(2)}倍`);
 console.log(`過大 ${ok.filter(r=>r.ratio>1).length} / 過小 ${ok.filter(r=>r.ratio<1).length}`);
})();
