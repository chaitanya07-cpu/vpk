// Vivekananda Pashukhadya Kendra - local server. No dependencies. Data lives in ./data
const http=require('http'),fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const CLOUD=!!process.env.APP_PASSWORD,PHONE=CLOUD||process.argv.includes('--phone'),PORT=+process.env.PORT||5050,HOST=PHONE?'0.0.0.0':(process.env.HOST||'127.0.0.1');
const DATA=process.env.DATA_DIR||path.join(__dirname,'data'),BK=path.join(DATA,'backups'),DB=path.join(DATA,'db.json'),LOG=path.join(DATA,'journal.log');
const TYPES=['Goli Pend','Sarki','Bhusa','Other'];
fs.mkdirSync(BK,{recursive:true});
let PW='';const bad={};   // phone mode: password for other devices (change it by editing data/phone-password.txt)
if(CLOUD)PW=process.env.APP_PASSWORD;else if(PHONE){const f=path.join(DATA,'phone-password.txt');if(!fs.existsSync(f))fs.writeFileSync(f,String(crypto.randomInt(100000,999999)));PW=fs.readFileSync(f,'utf8').trim()}
const stamp=()=>new Date().toISOString().replace(/[-:T]/g,'').replace('Z','').replace('.','-');
const ok=j=>{try{const d=JSON.parse(j);return d&&Array.isArray(d.farmers)&&Array.isArray(d.sales)&&Array.isArray(d.stock)?d:null}catch{return null}};
function load(){
  if(fs.existsSync(DB)){const d=ok(fs.readFileSync(DB,'utf8'));if(d)return d;console.log('db.json damaged - trying backups');
    for(const f of fs.readdirSync(BK).sort().reverse()){const b=ok(fs.readFileSync(path.join(BK,f),'utf8'));if(b){console.log('Recovered from',f);return b}}
    console.error('db.json is damaged and no backup is readable. NOT overwriting. Check the data folder.');process.exit(1)}
  return {farmers:[],sales:[],stock:[]}}
let db=load();db.payments=db.payments||[];
function save(op,info){
  fs.appendFileSync(LOG,JSON.stringify({t:new Date().toISOString(),op,info})+'\n');   // write-ahead journal, never overwritten
  const j=JSON.stringify(db,null,1),tmp=DB+'.tmp',fd=fs.openSync(tmp,'w');
  fs.writeSync(fd,j);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(tmp,DB);          // atomic replace
  fs.writeFileSync(path.join(BK,'db-'+stamp()+'.json'),j);                               // backup after every change
  const fl=fs.readdirSync(BK).sort(),days=new Set(),keep=new Set(fl.slice(-300));       // keep newest 300 + first of every day
  fl.forEach(f=>{const d=f.slice(3,11);if(!days.has(d)){days.add(d);keep.add(f)}});
  fl.forEach(f=>{if(!keep.has(f))fs.unlinkSync(path.join(BK,f))})}
const live=a=>a.filter(x=>!x.deleted);
function avail(t){let n=0;live(db.stock).forEach(s=>{if(s.type===t)n+=s.bags});live(db.sales).forEach(s=>s.items.forEach(i=>{if(i.type===t)n-=i.bags}));return n}
const id=()=>crypto.randomBytes(6).toString('hex');
const num=(v,min)=>{v=+v;if(!isFinite(v)||v<min)throw new Error('Invalid number');return v};
function api(m,u,b){
  if(m==='GET'&&u==='/api/state'){const fl=fs.readdirSync(BK).sort();return {farmers:live(db.farmers),sales:live(db.sales),stock:live(db.stock),payments:live(db.payments),meta:{dataDir:DATA,backups:fl.length,lastBackup:fl.pop()||null}}}
  if(m==='POST'&&u==='/api/stock'){const type=b.type;if(!TYPES.includes(type))throw new Error('Bad bag type');
    db.stock.push({id:id(),date:b.date,type,bags:num(b.bags,1),cost:num(b.cost,0),supplier:String(b.supplier||'').slice(0,80),at:new Date().toISOString()});save('stock',b);return {ok:1}}
  if(m==='POST'&&u==='/api/payment'){if(!live(db.farmers).find(f=>f.id===b.farmerId))throw new Error('Farmer not found');
    db.payments.push({id:id(),farmerId:b.farmerId,date:b.date,amount:num(b.amount,0.01),note:String(b.note||'').slice(0,200),at:new Date().toISOString()});save('payment',b);return {ok:1}}
  if(m==='POST'&&u==='/api/sale'){
    const name=String(b.name||'').trim(),village=String(b.village||'').trim();if(!name)throw new Error('Farmer name required');
    const items=(b.items||[]).filter(i=>+i.bags>0).map(i=>{if(!TYPES.includes(i.type))throw new Error('Bad bag type');return {type:i.type,bags:num(i.bags,1),amount:num(i.amount,0),paid:num(i.paid||0,0),note:String(i.note||'').slice(0,200)}}).map(i=>{if(i.paid>i.amount)throw new Error('Payment is more than the total for '+i.type);return i});
    if(!items.length)throw new Error('Enter bags for at least one type');
    for(const t of TYPES){const need=items.filter(i=>i.type===t).reduce((a,i)=>a+i.bags,0);if(need>avail(t))throw new Error(`Not enough stock of ${t}: only ${avail(t)} bags available`)}
    let f=live(db.farmers).find(x=>x.name.toLowerCase()===name.toLowerCase()&&(x.village||'').toLowerCase()===village.toLowerCase());
    if(!f){f={id:id(),name,village,phone:'',at:new Date().toISOString()};db.farmers.push(f)}
    if(b.phone)f.phone=String(b.phone).trim();
    const sale={id:id(),date:b.date,farmerId:f.id,items,total:items.reduce((a,i)=>a+i.amount,0),at:new Date().toISOString()};
    db.sales.push(sale);save('sale',sale);return {sale,farmer:f}}
  let r;
  if(m==='DELETE'&&(r=u.match(/^\/api\/(sale|stock|payment)\/(\w+)$/))){const list={sale:db.sales,stock:db.stock,payment:db.payments}[r[1]],x=list.find(y=>y.id===r[2]);if(!x)throw new Error('Not found');
    if(r[1]==='stock'){x.deleted=1;if(TYPES.some(t=>avail(t)<0)){x.deleted=0;throw new Error('Cannot delete: that stock was already sold')}}
    x.deleted=1;x.deletedAt=new Date().toISOString();save('delete-'+r[1],x.id);return {ok:1}}   // soft delete: record stays in the file
  if(m==='GET'&&u==='/api/backup')return {raw:JSON.stringify(db,null,1)};
  if(m==='POST'&&u==='/api/restore'){const d=ok(JSON.stringify(b));if(!d)throw new Error('Not a valid backup file');
    fs.writeFileSync(path.join(BK,'db-'+stamp()+'-before-restore.json'),JSON.stringify(db));db=d;db.payments=db.payments||[];save('restore',{});return {ok:1}}
  return null}
http.createServer((q,s)=>{
  const send=(c,t,d,h={})=>{s.writeHead(c,{'Content-Type':t,'Cache-Control':'no-store',...h});s.end(d)};
  const host=(q.headers.host||'').split(':')[0];
  if(HOST==='127.0.0.1'&&!['localhost','127.0.0.1'].includes(host))return send(403,'text/plain','Forbidden');
  const ra=q.socket.remoteAddress,ip=CLOUD?String(q.headers['x-forwarded-for']||ra).split(',')[0].trim():ra,local=!CLOUD&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ra);
  if(PHONE&&!local){if((bad[ip]||0)>=10)return send(429,'text/plain','Too many wrong passwords. Wait and try later.');
    const pw=Buffer.from((q.headers.authorization||'').replace(/^Basic /,''),'base64').toString().split(':').slice(1).join(':');
    if(!PW||pw!==PW){bad[ip]=(bad[ip]||0)+1;setTimeout(()=>delete bad[ip],3e5);return send(401,'text/plain','Password required',{'WWW-Authenticate':'Basic realm="Vivekananda Pashukhadya Kendra"'})}}
  const u=q.url.split('?')[0];
  if(q.method==='GET'&&(u==='/'||u==='/index.html'))return send(200,'text/html; charset=utf-8',fs.readFileSync(path.join(__dirname,'index.html')));
  if(!u.startsWith('/api/'))return send(404,'text/plain','Not found');
  if(q.method!=='GET'&&q.headers['x-requested-with']!=='vpk')return send(403,'text/plain','Forbidden');
  let body='';q.on('data',c=>{body+=c;if(body.length>3e7)q.destroy()});
  q.on('end',()=>{try{const r=api(q.method,u,body?JSON.parse(body):{});
    if(!r)return send(404,'application/json','{"error":"Not found"}');
    if(r.raw)return send(200,'application/json',r.raw,{'Content-Disposition':`attachment; filename="VPK-backup-${stamp()}.json"`});
    send(200,'application/json',JSON.stringify(r))}catch(e){send(400,'application/json',JSON.stringify({error:e.message}))}})
}).on('error',e=>{if(e.code==='EADDRINUSE'){console.log('App is already running - opening it.');open()}else throw e}).listen(PORT,HOST,()=>{
  console.log(`\n  Vivekananda Pashukhadya Kendra is running at http://localhost:${PORT}\n  Data folder: ${DATA}\n  (keep this window open; close it to stop the app)\n`);
  if(PHONE&&!CLOUD){const ips=Object.values(require('os').networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal).map(a=>a.address);
    console.log('  PHONE MODE ON. On your phone (same Wi-Fi) open:\n'+ips.map(a=>`      http://${a}:${PORT}`).join('\n')+`\n  Password (username can be anything): ${PW}\n`)}
  open()});
function open(){const u=`http://localhost:${PORT}`;if(process.env.NO_OPEN||CLOUD)return;
  cp.exec(process.platform==='win32'?`start "" "${u}"`:process.platform==='darwin'?`open ${u}`:`xdg-open ${u}`,()=>{})}
