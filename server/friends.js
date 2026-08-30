'use strict';
/**
 * Друзья + живые состояния + заявки + приватность
 * - Убрана броня везде
 * - Друзья показываются всегда карточками с nick/uid/online, если online — сервер, если spookytime — анка/коорды (с учетом приватности)
 * - Добавление через заявку + телеграм уведомление
 * - Приватность: вкладка Конфиденциальность
 */

const db = require('./db');

const WINDOW_MS = 60 * 1000;
const MAX_REQ_IP = 30;
const ipBuckets = new Map();
function getIp(req) { const fwd = req.headers['x-forwarded-for']; if (fwd) return fwd.split(',')[0].trim(); return req.socket.remoteAddress || 'unknown'; }
function isRateLimited(ip) {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + WINDOW_MS }; ipBuckets.set(ip, b); }
  b.count++; return b.count > MAX_REQ_IP;
}
setInterval(() => { const now = Date.now(); for (const [ip,b] of ipBuckets) if (now > b.resetAt) ipBuckets.delete(ip); }, 5*60*1000).unref();

const HWID_RE = /^[0-9a-fA-F]{64}$/;
const SESSION_COOKIE = 'ic_sid';
function readJsonBody(req, maxBytes) {
  const limit = maxBytes || 32*1024;
  return new Promise((resolve, reject) => {
    let data=''; let size=0;
    req.on('data', chunk=>{ size+=chunk.length; if(size>limit){ reject(new Error('Payload too large')); req.destroy(); return; } data+=chunk; });
    req.on('end', ()=>{ if(!data) return resolve({}); try{ resolve(JSON.parse(data)); }catch(e){ reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS, GET','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store'});
  res.end(body);
}
function handleCors(req,res){ if(req.method!=='OPTIONS') return false; res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS, GET','Access-Control-Allow-Headers':'Content-Type'}); res.end(); return true; }
function parseCookies(req){ const header=req.headers.cookie; const out={}; if(!header) return out; header.split(';').forEach(part=>{ const idx=part.indexOf('='); if(idx===-1) return; const k=part.slice(0,idx).trim(); const v=part.slice(idx+1).trim(); out[k]=decodeURIComponent(v); }); return out; }
function getSessionUser(req){
  const token=parseCookies(req)[SESSION_COOKIE]; if(!token) return null;
  const session=db.prepare('SELECT * FROM sessions WHERE token=?').get(token); if(!session) return null;
  if(new Date(session.expires_at).getTime()<Date.now()) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id)||null;
}
function resolveUser(req, body){
  const sess=getSessionUser(req); if(sess) return sess;
  const hwid=String(body.hwid||'').trim().toLowerCase();
  if(!HWID_RE.test(hwid)) return null;
  const user=db.prepare('SELECT * FROM users WHERE hwid=? COLLATE NOCASE').get(hwid);
  if(!user) return null; if(user.banned) return null;
  const hasSub=user.subscription_until && new Date(user.subscription_until).getTime()>Date.now();
  if(!hasSub) return null; return user;
}
function onlinedAt(updatedAtIso){ if(!updatedAtIso) return false; const ts=new Date(updatedAtIso).getTime(); if(Number.isNaN(ts)) return false; return Date.now()-ts<5*60*1000; }
function parseJsonField(v){ if(v==null) return null; if(typeof v!=='string') return v; try{ return JSON.parse(v);}catch(e){ return null; } }

function getPrivacy(user){
  try{ if(!user.privacy) return {showOnline:true,showServer:true,showAnarchy:true,showCoords:true}; const p=JSON.parse(user.privacy); return {showOnline:p.showOnline!==false, showServer:p.showServer!==false, showAnarchy:p.showAnarchy!==false, showCoords:p.showCoords!==false}; }catch(e){ return {showOnline:true,showServer:true,showAnarchy:true,showCoords:true}; }
}
async function sendTelegram(chatId, text){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  if(!token||!chatId) return;
  try{ await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML'})}); }catch(e){}
}

// --- handlers ---
async function handleFriendsState(req,res){
  if(handleCors(req,res)) return;
  if(req.method!=='POST'){ res.writeHead(405); return res.end('Method not allowed'); }
  if(isRateLimited(getIp(req))) return sendJson(res,429,{status:'reject',error:'rate_limited'});
  let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); }
  const user=resolveUser(req,body); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  const now=new Date().toISOString();
  const items=Array.isArray(body.items)?JSON.stringify(body.items):(body.items||null);
  const num=x=> (typeof x==='number'&&!Number.isNaN(x)?x:null);
  db.prepare(`
    INSERT INTO live_states (user_id, login, nick, server, anarchy_num, x, y, z, hp, items, head, hidden, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET login=excluded.login, nick=excluded.nick, server=excluded.server, anarchy_num=excluded.anarchy_num, x=excluded.x, y=excluded.y, z=excluded.z, hp=excluded.hp, items=excluded.items, head=excluded.head, hidden=excluded.hidden, updated_at=excluded.updated_at;
  `).run(user.id, user.login, body.nick!=null?String(body.nick):null, body.server!=null?String(body.server):null, num(body.anarchy_num), num(body.x), num(body.y), num(body.z), typeof body.hp==='number'&&!Number.isNaN(body.hp)?body.hp:null, items, body.head!=null?String(body.head):null, body.hidden?1:0, now);
  sendJson(res,200,{status:'access',ok:true});
}
async function handleFriendsList(req,res){
  if(handleCors(req,res)) return;
  if(req.method!=='POST'){ res.writeHead(405); return res.end('Method not allowed'); }
  if(isRateLimited(getIp(req))) return sendJson(res,429,{status:'reject',error:'rate_limited'});
  let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'});}
  const user=resolveUser(req,body); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  const rows=db.prepare(`
    SELECT u.id as uid, u.login as login, u.privacy as privacy,
           ls.nick as nick, ls.server as server, ls.anarchy_num as anarchy_num, ls.x as x, ls.y as y, ls.z as z, ls.hp as hp, ls.items as items, ls.head as head, ls.hidden as hidden, ls.updated_at as updated_at
    FROM friends f JOIN users u ON u.id=f.friend_id LEFT JOIN live_states ls ON ls.user_id=f.friend_id WHERE f.user_id=? ORDER BY u.login COLLATE NOCASE
  `).all(user.id);
  const friends=rows.map(r=>{
    const isOnline=onlinedAt(r.updated_at);
    const priv=getPrivacy({privacy:r.privacy});
    // respect target privacy
    let out={uid:r.uid, login:r.login, nick:r.nick, online:isOnline && priv.showOnline};
    if(!isOnline || !priv.showOnline) { out.online=false; return out; }
    if(priv.showServer) out.server=r.server;
    if(r.server==='spookytime' && priv.showAnarchy) out.anarchy_num=r.anarchy_num;
    if(priv.showCoords && r.x!=null) { out.x=r.x; out.y=r.y; out.z=r.z; }
    else { out.x=null; out.y=null; out.z=null; }
    out.hp=r.hp; out.items=parseJsonField(r.items); out.head=r.head; out.hidden=!!r.hidden; out.updated_at=r.updated_at;
    return out;
  });
  sendJson(res,200,{status:'access',friends});
}
async function handleUserSearch(req,res){
  if(handleCors(req,res)) return;
  // allow GET and POST
  let q='';
  if(req.method==='GET'){ const url=new URL(req.url, `http://${req.headers.host}`); q=String(url.searchParams.get('q')||'').trim(); }
  else { let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); } q=String(body.q||body.query||'').trim(); }
  const user=getSessionUser(req); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  if(!q || q.length<2) return sendJson(res,200,{users:[]});
  const like='%'+q+'%';
  const rows=db.prepare(`SELECT id as uid, login, (SELECT COUNT(*) FROM friends WHERE user_id=? AND friend_id=users.id) as isFriend FROM users WHERE login LIKE ? COLLATE NOCASE AND id!=? ORDER BY login COLLATE NOCASE LIMIT 20`).all(user.id, like, user.id);
  sendJson(res,200,{users:rows.map(r=>({uid:r.uid, login:r.login, isFriend:!!r.isFriend}))});
}
async function handleFriendsAdd(req,res){
  // now creates request, not mutual
  if(handleCors(req,res)) return;
  if(req.method!=='POST'){ res.writeHead(405); return res.end('Method not allowed'); }
  if(isRateLimited(getIp(req))) return sendJson(res,429,{status:'reject',error:'rate_limited'});
  let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); }
  const user=resolveUser(req,body); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  const login=String(body.login||'').trim(); if(!login) return sendJson(res,400,{status:'reject',error:'empty_login'});
  const target=db.prepare('SELECT * FROM users WHERE login=? COLLATE NOCASE').get(login);
  if(!target) return sendJson(res,404,{status:'reject',error:'not_found'});
  if(target.id===user.id) return sendJson(res,400,{status:'reject',error:'self'});
  const exists=db.prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=?').get(user.id,target.id);
  if(exists) return sendJson(res,400,{status:'reject',error:'already_friends'});
  const pending=db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=? AND status=?').get(user.id,target.id,'pending');
  if(pending) return sendJson(res,400,{status:'reject',error:'already_pending'});
  const revPending=db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=? AND status=?').get(target.id,user.id,'pending');
  if(revPending){ // auto accept if other already requested
    const now=new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id,created_at) VALUES (?,?,?)').run(user.id,target.id,now);
    db.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id,created_at) VALUES (?,?,?)').run(target.id,user.id,now);
    db.prepare('UPDATE friend_requests SET status=?, updated_at=? WHERE from_id=? AND to_id=?').run('accepted',now,target.id,user.id);
    return sendJson(res,200,{status:'access',friend:{login:target.login}, autoAccepted:true});
  }
  const now=new Date().toISOString();
  db.prepare('INSERT INTO friend_requests (from_id,to_id,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(user.id,target.id,'pending',now,now);
  if(target.telegram_chat_id) sendTelegram(target.telegram_chat_id, `👥 Заявка в друзья от <b>${user.login}</b> (UID ${user.id}). Прими в личном кабинете → Друзья.`);
  sendJson(res,200,{status:'access',request:{login:target.login}});
}
async function handleFriendRequests(req,res){
  if(handleCors(req,res)) return;
  let body={}; if(req.method==='POST'){ try{ body=await readJsonBody(req);}catch(e){} } else { const url=new URL(req.url, `http://${req.headers.host}`); body.q=url.searchParams.get('q'); }
  const user=getSessionUser(req) || resolveUser(req,body);
  if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  const incoming=db.prepare(`SELECT r.id, r.created_at, u.login, u.id as uid FROM friend_requests r JOIN users u ON u.id=r.from_id WHERE r.to_id=? AND r.status='pending' ORDER BY r.created_at DESC`).all(user.id);
  const outgoing=db.prepare(`SELECT r.id, r.created_at, u.login, u.id as uid FROM friend_requests r JOIN users u ON u.id=r.to_id WHERE r.from_id=? AND r.status='pending' ORDER BY r.created_at DESC`).all(user.id);
  sendJson(res,200,{incoming: incoming.map(r=>({id:r.id, login:r.login, uid:r.uid, createdAt:r.created_at})), outgoing: outgoing.map(r=>({id:r.id, login:r.login, uid:r.uid, createdAt:r.created_at}))});
}
async function handleFriendAccept(req,res){
  if(handleCors(req,res)) return;
  if(req.method!=='POST'){ res.writeHead(405); return res.end('Method not allowed'); }
  let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); }
  const user=getSessionUser(req)||resolveUser(req,body); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  const login=String(body.login||body.from||'').trim(); if(!login) return sendJson(res,400,{status:'reject',error:'empty_login'});
  const from=db.prepare('SELECT * FROM users WHERE login=? COLLATE NOCASE').get(login);
  if(!from) return sendJson(res,404,{status:'reject',error:'not_found'});
  const reqRow=db.prepare('SELECT * FROM friend_requests WHERE from_id=? AND to_id=? AND status=?').get(from.id,user.id,'pending');
  if(!reqRow) return sendJson(res,404,{status:'reject',error:'no_request'});
  const now=new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id,created_at) VALUES (?,?,?)').run(user.id,from.id,now);
  db.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id,created_at) VALUES (?,?,?)').run(from.id,user.id,now);
  db.prepare('UPDATE friend_requests SET status=?, updated_at=? WHERE id=?').run('accepted',now,reqRow.id);
  sendJson(res,200,{status:'access',ok:true});
}
async function handleFriendDecline(req,res){
  if(handleCors(req,res)) return;
  if(req.method!=='POST'){ res.writeHead(405); return res.end('Method not allowed'); }
  let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); }
  const user=getSessionUser(req)||resolveUser(req,body); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  const login=String(body.login||body.from||'').trim(); if(!login) return sendJson(res,400,{status:'reject',error:'empty_login'});
  const from=db.prepare('SELECT * FROM users WHERE login=? COLLATE NOCASE').get(login);
  if(!from) return sendJson(res,404,{status:'reject',error:'not_found'});
  const reqRow=db.prepare('SELECT * FROM friend_requests WHERE from_id=? AND to_id=? AND status=?').get(from.id,user.id,'pending');
  if(!reqRow) return sendJson(res,404,{status:'reject',error:'no_request'});
  db.prepare('UPDATE friend_requests SET status=?, updated_at=? WHERE id=?').run('declined',new Date().toISOString(),reqRow.id);
  sendJson(res,200,{status:'access',ok:true});
}
async function handleFriendsRemove(req,res){
  if(handleCors(req,res)) return;
  if(req.method!=='POST'){ res.writeHead(405); return res.end('Method not allowed'); }
  if(isRateLimited(getIp(req))) return sendJson(res,429,{status:'reject',error:'rate_limited'});
  let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); }
  const user=resolveUser(req,body); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  const login=String(body.login||'').trim(); if(!login) return sendJson(res,400,{status:'reject',error:'empty_login'});
  const target=db.prepare('SELECT * FROM users WHERE login=? COLLATE NOCASE').get(login);
  if(!target) return sendJson(res,404,{status:'reject',error:'not_found'});
  db.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').run(user.id,target.id);
  db.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').run(target.id,user.id);
  db.prepare('DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').run(user.id,target.id,target.id,user.id);
  sendJson(res,200,{status:'access',ok:true});
}
async function handlePrivacyGet(req,res){
  if(handleCors(req,res)) return;
  const user=getSessionUser(req); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  let p={showOnline:true,showServer:true,showAnarchy:true,showCoords:true};
  try{ if(user.privacy) p=Object.assign(p, JSON.parse(user.privacy)); }catch(e){}
  sendJson(res,200,{privacy:p});
}
async function handlePrivacySet(req,res){
  if(handleCors(req,res)) return;
  if(req.method!=='POST'){ res.writeHead(405); return res.end('Method not allowed'); }
  const user=getSessionUser(req); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  let body; try{ body=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); }
  const p={showOnline: body.showOnline!==false, showServer: body.showServer!==false, showAnarchy: body.showAnarchy!==false, showCoords: body.showCoords!==false};
  db.prepare('UPDATE users SET privacy=? WHERE id=?').run(JSON.stringify(p), user.id);
  sendJson(res,200,{privacy:p});
}
module.exports={handleFriendsState,handleFriendsList,handleFriendsAdd,handleFriendsRemove, handleUserSearch: async (req,res)=>{ // keep old search alias
  if(handleCors(req,res)) return;
  let q=''; if(req.method==='GET'){ const url=new URL(req.url, `http://${req.headers.host}`); q=String(url.searchParams.get('q')||'').trim(); } else { let b; try{ b=await readJsonBody(req);}catch(e){ return sendJson(res,400,{status:'reject',error:'bad_request'}); } q=String(b.q||b.query||'').trim(); }
  const user=getSessionUser(req); if(!user) return sendJson(res,401,{status:'reject',error:'auth'});
  if(!q||q.length<2) return sendJson(res,200,{users:[]});
  const like='%'+q+'%';
  const rows=db.prepare(`SELECT id as uid, login FROM users WHERE login LIKE ? COLLATE NOCASE AND id!=? ORDER BY login COLLATE NOCASE LIMIT 20`).all(like, user.id);
  sendJson(res,200,{users:rows.map(r=>({uid:r.uid, login:r.login}))});
}, handleFriendRequests, handleFriendAccept, handleFriendDecline, handlePrivacyGet, handlePrivacySet};
