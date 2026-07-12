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
const g=n=>{const a=src.indexOf('const '+n+' = `')+('const '+n+' = `').length;
 const b=src.indexOf('`;',a); if(a<20||b<0) throw new Error('抽出失敗: '+n); return src.slice(a,b);};
const A=g('AREA_SCALE_GUIDE'),W=g('WALL_SCALE_GUIDE'),F=g('FLOOR_SCALE_GUIDE');
const i=src.indexOf('## まず、何を測るのかを決めろ'), j=src.indexOf('}`,', i);
let body=src.slice(i,j+1)
  .replace('${AREA_SCALE_GUIDE}',A).replace('${WALL_SCALE_GUIDE}',W).replace('${FLOOR_SCALE_GUIDE}',F);
const ds=JSON.parse(fs.readFileSync('ds_truth.json','utf8'));
const pick=id=>ds.find(x=>x.id===id);
const cases=[
 ['屋根カバー工法をお願いしたい', pick('kobenishi-slate-110')],
 ['外壁塗装の見積をお願いします', pick('kobenishi-slate-110')],
 ['屋根の遮熱シート施工', pick('zephan-seppan-950')],
 ['店舗の内装リフォーム', pick('teigaku-noda-92')],
];
(async()=>{ for(const [comment,it] of cases){
  const buf=fs.readFileSync(it.file);
  const r=await client.messages.create({model:'claude-sonnet-4-6',max_tokens:1500,temperature:0,
   system:'あなたは建築の積算担当者です。写真から工事対象の面積・数量だけを推定します。金額は一切出しません。',
   messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:buf.toString('base64')}},
    {type:'text',text:`依頼内容: ${comment}\n\nこの写真の工事対象について、**寸法だけ**を答えてください。面積は計算しないでください（こちらで計算します）。\n\n${body}`}]}]});
  const o=JSON.parse(r.content[0].text.match(/\{[\s\S]*\}/)[0]);
  const w=+o.widthM||0,l=+o.lengthM||0,h=+o.heightM||0,op=+o.openingFactor||1;
  const t=o.target;
  const raw = t==='wall' ? (w&&l&&h ? 2*(w+l)*h*op : 0)
            : (w&&l ? w*l*(t==='roof'?(+o.slopeFactor||1)*(+o.developFactor||1):1) : 0);
  console.log(`「${comment}」\n  target=${t}  w=${w} l=${l} h=${h} open=${op} slope=${o.slopeFactor} dev=${o.developFactor}\n  生面積=${raw.toFixed(1)}㎡  cover=${o.coversWholeRoof}  ${String(o.basis).slice(0,50)}\n`);
 }})();
