'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || '/data');
const PANEL_ROOT = path.join(DATA_ROOT, 'panel');
const CONFIG_FILE = path.join(PANEL_ROOT, 'config.json');
const APPS_FILE = path.join(PANEL_ROOT, 'apps.json');
const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;
const sessions = new Map();
const loginAttempts = new Map();
const runningApps = new Map();
let config;
let apps = [];

const COMMANDS = new Set(['pwd', 'ls', 'find', 'cat', 'head', 'tail', 'grep', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'node', 'npm', 'npx', 'python3', 'pip3', 'git', 'sqlite3', 'ffmpeg', 'du', 'df', 'whoami', 'date']);
const BLOCKED_WORDS = /(^|\s)(sudo|su|mount|umount|mkfs|fdisk|parted|iptables|nft|systemctl|service|reboot|shutdown|init|killall|pkill|nc|ncat|netcat|ssh|scp|telnet|docker|podman)(\s|$)/i;
const BLOCKED_SYNTAX = /[;&|<>`$]|\$\(|\.\.|\x00/;

function now() { return new Date().toISOString(); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }
function hashPassword(password, salt = randomToken(16)) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, encoded) {
  try {
    const [, salt, expected] = String(encoded).split('$');
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim().split('=')) .filter(v => v.length === 2));
}
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data), ...extra });
  res.end(data);
}
function json(res, status, body, extra = {}) { send(res, status, body, 'application/json; charset=utf-8', extra); }
function fail(res, status, message) { json(res, status, { ok: false, error: message }); }
async function body(req, limit = MAX_JSON) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  const raw = await body(req, MAX_JSON);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}
function safePath(input = '') {
  const clean = String(input).replaceAll('\\', '/');
  if (clean.includes('\0')) throw new Error('Invalid path');
  const resolved = path.resolve(DATA_ROOT, clean.replace(/^\/+/, ''));
  if (resolved !== DATA_ROOT && !resolved.startsWith(DATA_ROOT + path.sep)) throw new Error('Path outside data directory');
  return resolved;
}
function relative(file) { return path.relative(DATA_ROOT, file).split(path.sep).join('/') || '.'; }
function session(req) {
  const token = cookies(req).panel_session;
  return token ? sessions.get(token) : null;
}
function requireAuth(req, res) {
  const s = session(req);
  if (!s) { fail(res, 401, 'Login required'); return null; }
  if (req.method !== 'GET' && req.url !== '/api/logout' && req.headers['x-csrf-token'] !== s.csrf) { fail(res, 403, 'Invalid CSRF token'); return null; }
  return s;
}
function requireChanged(s, res) {
  if (config.mustChangePassword) { fail(res, 423, 'Change the default username and password first'); return false; }
  return true;
}
async function init() {
  await fsp.mkdir(PANEL_ROOT, { recursive: true });
  try { config = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8')); }
  catch {
    config = { username: process.env.PANEL_USERNAME || 'admin', passwordHash: hashPassword(process.env.PANEL_PASSWORD || 'admin'), mustChangePassword: true, createdAt: now() };
    await saveConfig();
  }
  try { apps = JSON.parse(await fsp.readFile(APPS_FILE, 'utf8')); if (!Array.isArray(apps)) apps = []; }
  catch { apps = []; await saveApps(); }
}
async function saveConfig() { await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 }); }
async function saveApps() { await fsp.writeFile(APPS_FILE, JSON.stringify(apps, null, 2), { mode: 0o600 }); }
function publicApp(app) { const child = runningApps.get(app.id); return { id: app.id, name: app.name, cwd: app.cwd, command: app.command, envKeys: Object.keys(app.env || {}), createdAt: app.createdAt, running: Boolean(child && !child.killed), pid: child?.pid || null, log: child?.log?.slice(-12000) || '' }; }
function appById(id) { return apps.find(a => a.id === id); }
function safeCommand(command) {
  const text = String(command || '').trim();
  if (!text || text.length > 600) throw new Error('Command is empty or too long');
  if (BLOCKED_SYNTAX.test(text) || BLOCKED_WORDS.test(text) || /(^|\s)\/(?!data(?:\/|\s|$))/i.test(text)) throw new Error('Unsafe command rejected');
  const first = text.match(/^([a-zA-Z0-9_.-]+)/)?.[1];
  if (!first || !COMMANDS.has(first)) throw new Error(`Command not allowed. Allowed: ${[...COMMANDS].join(', ')}`);
  return text;
}
function startApp(app) {
  if (runningApps.has(app.id)) return;
  const cwd = safePath(app.cwd || '');
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn('bash', ['-lc', app.command], { cwd, env: { ...process.env, ...(app.env || {}), PANEL_APP_ID: app.id }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = `[${now()}] started pid ${child.pid}\n`;
  const add = chunk => { child.log = (child.log + chunk.toString()).slice(-12000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('close', (code, signal) => { add(`[${now()}] exited code=${code} signal=${signal || '-'}\n`); runningApps.delete(app.id); });
  child.on('error', err => { add(`[${now()}] error ${err.message}\n`); runningApps.delete(app.id); });
  runningApps.set(app.id, child);
}
function stopApp(id) { const child = runningApps.get(id); if (child) { child.kill('SIGTERM'); setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000).unref(); } }
function parseContentType(req) { return String(req.headers['content-type'] || '').split(';')[0].trim(); }


const CSS = `<style>
:root{--bg:#090d18;--panel:#101827;--panel2:#151f31;--line:#263650;--text:#e9efff;--muted:#91a0bb;--accent:#6ea8ff;--green:#42d392;--red:#ff6d85;--yellow:#ffd166}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer;border:0}.login-bg{min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#19305b 0,#090d18 55%)}.login-card{width:min(430px,calc(100% - 28px));padding:30px;border:1px solid var(--line);border-radius:24px;background:#101827ee;box-shadow:0 28px 90px #0008}.brand{display:flex;gap:13px;align-items:center;margin-bottom:28px}.brand-mark{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,#6ea8ff,#9b7bff);font-size:26px}.brand b{display:block;font-size:19px}.brand small{display:block;color:var(--muted);margin-top:4px}label{display:block;color:var(--muted);font-size:13px;margin:14px 0}input,textarea,select{width:100%;margin-top:7px;padding:11px 12px;color:var(--text);background:#0b1220;border:1px solid var(--line);border-radius:10px;outline:0}input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px #6ea8ff1c}.primary,.secondary,.danger{padding:10px 15px;border-radius:10px;color:white}.primary{width:100%;background:linear-gradient(135deg,#3978e8,#7659dd);margin-top:10px}.secondary{background:#22314c}.danger{background:#542137;color:#ffafbd}.hint{font-size:12px;line-height:1.8;color:var(--muted);margin-top:18px}.error{color:var(--red);min-height:20px;font-size:13px}.app-shell{min-height:100vh;display:flex}.sidebar{width:250px;border-left:1px solid var(--line);background:#0d1422;padding:22px 15px;display:flex;flex-direction:column}.side-brand{padding:7px 10px 24px;font-weight:800}.side-brand span{color:var(--accent)}.nav{display:grid;gap:6px}.nav button{text-align:right;padding:12px;border-radius:10px;background:transparent;color:var(--muted)}.nav button.active,.nav button:hover{background:#1b2a42;color:var(--text)}.side-bottom{margin-top:auto;color:var(--muted);font-size:12px;padding:10px}.main{flex:1;min-width:0}.topbar{height:76px;padding:16px 28px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}.topbar h1{font-size:20px;margin:0}.topbar small{display:block;color:var(--muted);margin-top:4px}.user-pill{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:13px}.avatar{display:grid;place-items:center;width:35px;height:35px;border-radius:50%;background:#243a60;color:#bcd6ff}.content{padding:28px;max-width:1400px}.banner{display:none;padding:13px 15px;border:1px solid #765a24;background:#352918;color:#ffe2a0;border-radius:12px;margin-bottom:18px}.banner.show{display:flex;justify-content:space-between;gap:14px;align-items:center}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{border:1px solid var(--line);background:linear-gradient(145deg,#121d30,#0f1726);border-radius:16px;padding:18px}.stat small{color:var(--muted)}.stat strong{display:block;font-size:27px;margin-top:8px}.section{margin-top:22px}.section-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.section-title h2{font-size:16px;margin:0}.muted{color:var(--muted)}.page{display:none}.page.active{display:block}.toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.toolbar input{width:300px;margin:0}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:13px}.file-row,.app-row{display:grid;grid-template-columns:1fr 120px 170px;gap:14px;align-items:center;padding:13px 15px;border-bottom:1px solid #1d2a40}.file-row:last-child,.app-row:last-child{border-bottom:0}.file-name{color:#b9d4ff;cursor:pointer}.file-name:hover{text-decoration:underline}.actions{display:flex;gap:7px;justify-content:flex-end;flex-wrap:wrap}.mini{padding:7px 10px;background:#22314c;color:#d8e5ff;border-radius:8px;font-size:12px}.mini.red{color:#ffb0bd;background:#442136}.editor{min-height:360px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;direction:ltr;text-align:left}.terminal{min-height:300px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;direction:ltr;text-align:left}.terminal-output{min-height:180px;max-height:440px;overflow:auto;white-space:pre-wrap;background:#070b12;border:1px solid var(--line);border-radius:12px;padding:14px;color:#bde7c9;direction:ltr;text-align:left}.two{display:grid;grid-template-columns:1fr 1fr;gap:15px}.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#76859e;margin-left:5px}.status-dot.on{background:var(--green);box-shadow:0 0 10px #42d392}.empty{text-align:center;padding:35px;color:var(--muted)}@media(max-width:850px){.sidebar{width:72px;padding:14px 8px}.side-brand{font-size:0;text-align:center}.side-brand span{font-size:20px}.nav button{font-size:0;text-align:center}.nav button:before{content:'◈';font-size:18px}.side-bottom{display:none}.content{padding:18px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.topbar{padding:14px 18px}.two{grid-template-columns:1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}.file-row,.app-row{grid-template-columns:1fr}.actions{justify-content:flex-start}}
</style>`;

const LOGIN_HTML = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Railway Linux Panel</title>${CSS}</head><body class="login-bg"><main class="login-card"><div class="brand"><span class="brand-mark">⌘</span><div><b>Railway Linux Panel</b><small>Secure container control center</small></div></div><form id="login"><label>نام کاربری<input name="username" autocomplete="username" required autofocus></label><label>رمز عبور<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">ورود به پنل</button><p id="err" class="error"></p></form><div class="hint">در اولین ورود با اطلاعات پیش‌فرض، حتماً نام کاربری و رمز را عوض کن.</div></main><script>login.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(login)))});const j=await r.json();if(j.ok)location.href='/';else err.textContent=j.error||'ورود ناموفق بود';}</script></body></html>`;

const APP_HTML = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Railway Linux Panel</title>${CSS}</head><body><div class="app-shell"><aside class="sidebar"><div class="side-brand"><span>⌘</span> Railway Panel</div><nav class="nav"><button data-page="overview" class="active">داشبورد</button><button data-page="files">فایل منیجر</button><button data-page="apps">برنامه‌ها و بات‌ها</button><button data-page="terminal">ترمینال</button><button data-page="settings">تنظیمات</button></nav><div class="side-bottom">Railway Linux Panel<br><span id="version">v1.0.0</span></div></aside><main class="main"><header class="topbar"><div><h1 id="title">داشبورد</h1><small id="subtitle">مدیریت امن کانتینر</small></div><div class="user-pill"><span id="username"></span><span class="avatar">◉</span><button class="mini" id="logout">خروج</button></div></header><div class="content"><div id="banner" class="banner"><span>رمز پیش‌فرض هنوز فعال است. برای امنیت، از بخش تنظیمات نام کاربری و رمز را تغییر بده.</span><button class="mini" data-go="settings">تغییر الان</button></div><section id="overview" class="page active"><div class="grid"><div class="card stat"><small>وضعیت پنل</small><strong id="panelStatus">فعال</strong></div><div class="card stat"><small>پردازش‌های فعال</small><strong id="runningCount">0</strong></div><div class="card stat"><small>حافظه</small><strong id="memory">-</strong></div><div class="card stat"><small>فضای داده</small><strong id="disk">-</strong></div></div><div class="section card"><div class="section-title"><h2>راهنمای شروع سریع</h2></div><p class="muted">برای اجرای سایت یا بات، ابتدا از بخش «برنامه‌ها و بات‌ها» یک برنامه بساز، مسیر پروژه و دستور اجرا را وارد کن و سپس Start را بزن.</p><p class="muted">فایل‌های دائمی را داخل <code>/data</code> نگه دار؛ این مسیر باید روی Railway به Volume متصل باشد.</p></div></section><section id="files" class="page"><div class="section-title"><h2>فایل منیجر</h2><div class="toolbar"><input id="filePath" value="." placeholder="مسیر داخل /data"><button class="secondary" id="loadFiles">بازخوانی</button><input type="file" id="uploadFile" hidden><button class="primary" style="width:auto" id="uploadBtn">آپلود</button></div></div><div class="card"><div id="fileList"></div></div><div class="section card"><div class="section-title"><h2>ویرایشگر فایل</h2><button class="primary" style="width:auto" id="saveFile">ذخیره فایل</button></div><input id="editPath" placeholder="مسیر فایل، مثال: apps/bot/bot.py"><textarea id="editor" class="editor" placeholder="یک فایل متنی را از لیست انتخاب کن..."></textarea></div></section><section id="apps" class="page"><div class="section-title"><h2>برنامه‌ها و بات‌ها</h2></div><div class="card"><div class="two"><label>نام برنامه<input id="appName" placeholder="my-bot"></label><label>مسیر اجرا نسبت به /data<input id="appCwd" value="." placeholder="apps/my-bot"></label></div><label>دستور اجرا<input id="appCommand" placeholder="python3 bot.py"></label><label>متغیرها، هر خط یک KEY=VALUE<textarea id="appEnv" rows="4" placeholder="TOKEN=...&#10;MODE=production"></textarea></label><button class="primary" style="width:auto" id="createApp">ساخت برنامه</button></div><div class="section card"><div id="appsList"></div></div></section><section id="terminal" class="page"><div class="section-title"><h2>ترمینال امن</h2><span class="muted">مسیر پایه: /data</span></div><div class="card"><textarea id="terminalInput" class="terminal" placeholder="مثال: ls -la"></textarea><div class="toolbar" style="margin-top:10px"><button class="primary" style="width:auto" id="runTerminal">اجرا</button><button class="mini" id="clearTerminal">پاک‌کردن خروجی</button></div><pre id="terminalOutput" class="terminal-output">خروجی اینجا نمایش داده می‌شود...</pre><p class="muted">برای امنیت، دستورات خطرناک و خروج از مسیر /data مسدود می‌شوند.</p></div></section><section id="settings" class="page"><div class="section-title"><h2>تنظیمات امنیتی</h2></div><div class="card"><h3>تغییر اطلاعات ورود</h3><p class="muted">رمز جدید حداقل ۸ کاراکتر باشد. اطلاعات جدید روی Volume در مسیر /data/panel ذخیره می‌شود.</p><label>رمز فعلی<input id="currentPassword" type="password"></label><div class="two"><label>نام کاربری جدید<input id="newUsername" autocomplete="username"></label><label>رمز جدید<input id="newPassword" type="password" autocomplete="new-password"></label></div><button class="primary" style="width:auto" id="saveCredentials">ذخیره اطلاعات ورود</button><p id="settingsMessage" class="muted"></p></div><div class="section card"><h3>نکات امنیتی</h3><ul class="muted"><li>پسورد را داخل GitHub نگذار.</li><li>پنل را عمومی و بدون احراز هویت منتشر نکن.</li><li>Volume را روی /data متصل کن تا تنظیمات بعد از Restart باقی بماند.</li><li>ترمینال عمداً فقط مجموعه‌ای از دستورات کاربردی را قبول می‌کند.</li></ul></div></section></div></main></div><script>
let csrf=''; const $=id=>document.getElementById(id); const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
async function api(url,opts={}){opts.headers={...(opts.headers||{}),'content-type':'application/json','x-csrf-token':csrf};const r=await fetch(url,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'خطا');return j}
function showPage(id){document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===id));document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===id));const names={overview:['داشبورد','مدیریت امن کانتینر'],files:['فایل منیجر','مدیریت فایل‌های /data'],apps:['برنامه‌ها و بات‌ها','اجرای سرویس‌های سبک'],terminal:['ترمینال','اجرای دستورات مجاز'],settings:['تنظیمات','امنیت و اطلاعات ورود']};$('title').textContent=names[id][0];$('subtitle').textContent=names[id][1];if(id==='files')loadFiles();if(id==='apps')loadApps()}
document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>showPage(b.dataset.page));document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>showPage(b.dataset.go));
async function init(){const s=await api('/api/session',{headers:{}});csrf=s.csrf;$('username').textContent=s.username;if(s.mustChange)$('banner').classList.add('show');loadOverview();loadFiles();loadApps();}
async function loadOverview(){const s=await api('/api/state');$('runningCount').textContent=s.runningApps;$('memory').textContent=s.memory; $('disk').textContent=s.disk}
async function loadFiles(){try{const p=$('filePath').value||'.';const j=await api('/api/files?path='+encodeURIComponent(p));$('fileList').innerHTML=j.items.length?j.items.map(x=>'<div class="file-row"><div class="file-name" data-path="'+esc(x.path)+'" data-dir="'+x.dir+'">'+(x.dir?'📁':'📄')+' '+esc(x.name)+'</div><div class="muted">'+(x.dir?'پوشه':x.size+' bytes')+'</div><div class="actions">'+(x.dir?'<button class="mini open-dir">بازکردن</button>':'<button class="mini open-file">ویرایش</button>')+'<button class="mini red delete-file">حذف</button></div></div>').join(''):'<div class="empty">این پوشه خالی است</div>';document.querySelectorAll('.open-dir').forEach(b=>b.onclick=()=>{const p=b.parentElement.parentElement.querySelector('.file-name').dataset.path;$('filePath').value=p;loadFiles()});document.querySelectorAll('.open-file').forEach(b=>b.onclick=async()=>{const p=b.parentElement.parentElement.querySelector('.file-name').dataset.path;const j=await api('/api/files/content?path='+encodeURIComponent(p));$('editPath').value=p;$('editor').value=j.content});document.querySelectorAll('.delete-file').forEach(b=>b.onclick=async()=>{const p=b.parentElement.parentElement.querySelector('.file-name').dataset.path;if(confirm('حذف شود؟')){await api('/api/files/delete',{method:'POST',body:JSON.stringify({path:p})});loadFiles()}})}catch(e){alert(e.message)}}
$('loadFiles').onclick=loadFiles;$('uploadBtn').onclick=()=>$('uploadFile').click();$('uploadFile').onchange=async()=>{const f=$('uploadFile').files[0];if(!f)return;const base=($('filePath').value||'.').replace(/^\\.|\\/$/g,'');const target=(base?base+'/':'')+f.name;const r=await fetch('/api/files/upload?path='+encodeURIComponent(target),{method:'POST',headers:{'x-csrf-token':csrf,'content-type':'application/octet-stream'},body:await f.arrayBuffer()});if(!r.ok){const j=await r.json();alert(j.error||'آپلود ناموفق بود')}else loadFiles()};$('saveFile').onclick=async()=>{try{await api('/api/files/save',{method:'POST',body:JSON.stringify({path:$('editPath').value,content:$('editor').value})});alert('ذخیره شد')}catch(e){alert(e.message)}};
async function loadApps(){const j=await api('/api/apps');$('appsList').innerHTML=j.apps.length?j.apps.map(a=>'<div class="app-row"><div><b>'+esc(a.name)+'</b><div class="muted">'+esc(a.command)+'<br>'+esc(a.cwd)+' <span class="status-dot '+(a.running?'on':'')+'"></span>'+(a.running?'در حال اجرا':'متوقف')+'</div></div><div class="muted">'+(a.pid?'PID '+a.pid:'')+'</div><div class="actions"><button class="mini" data-action="'+(a.running?'stop':'start')+'" data-id="'+a.id+'">'+(a.running?'توقف':'اجرا')+'</button><button class="mini" data-action="restart" data-id="'+a.id+'">Restart</button><button class="mini" data-action="log" data-id="'+a.id+'">لاگ</button><button class="mini red" data-action="delete" data-id="'+a.id+'">حذف</button></div></div>').join(''):'<div class="empty">هنوز برنامه‌ای ساخته نشده</div>';document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.id,act=b.dataset.action;if(act==='log'){const a=j.apps.find(x=>x.id===id);alert(a.log||'لاگی موجود نیست');return}await api('/api/apps/'+act,{method:'POST',body:JSON.stringify({id})});loadApps();loadOverview()}catch(e){alert(e.message)}})}
$('createApp').onclick=async()=>{try{const env={};($('appEnv').value||'').split('\\n').forEach(line=>{const i=line.indexOf('=');if(i>0)env[line.slice(0,i).trim()]=line.slice(i+1)});await api('/api/apps/create',{method:'POST',body:JSON.stringify({name:$('appName').value,cwd:$('appCwd').value,command:$('appCommand').value,env})});$('appName').value='';$('appCommand').value='';loadApps()}catch(e){alert(e.message)}};
$('runTerminal').onclick=async()=>{try{const j=await api('/api/terminal',{method:'POST',body:JSON.stringify({command:$('terminalInput').value})});$('terminalOutput').textContent=j.output||'(بدون خروجی)'}catch(e){$('terminalOutput').textContent=e.message}};$('clearTerminal').onclick=()=>$('terminalOutput').textContent='';
$('saveCredentials').onclick=async()=>{try{const j=await api('/api/settings/credentials',{method:'POST',body:JSON.stringify({currentPassword:$('currentPassword').value,username:$('newUsername').value,password:$('newPassword').value})});$('settingsMessage').textContent=j.message;$('currentPassword').value='';$('newPassword').value='';$('banner').classList.remove('show')}catch(e){$('settingsMessage').textContent=e.message}};$('logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.href='/login'};init().catch(()=>location.href='/login');
</script></body></html>`;

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'railway-linux-panel', uptime: Math.floor(process.uptime()) });
    if (req.method === 'GET' && url.pathname === '/login') return send(res, 200, LOGIN_HTML, 'text/html; charset=utf-8');
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const ip = req.socket.remoteAddress || 'unknown'; const attempt = loginAttempts.get(ip) || { count: 0, at: Date.now() };
      if (Date.now() - attempt.at > 15 * 60 * 1000) { attempt.count = 0; attempt.at = Date.now(); }
      if (attempt.count >= 5) return fail(res, 429, 'Too many login attempts; try again later');
      const input = await jsonBody(req);
      if (input.username !== config.username || !verifyPassword(String(input.password || ''), config.passwordHash)) { attempt.count++; loginAttempts.set(ip, attempt); return fail(res, 401, 'نام کاربری یا رمز عبور اشتباه است'); }
      loginAttempts.delete(ip); const token = randomToken(); const csrf = randomToken(16); sessions.set(token, { username: config.username, csrf, createdAt: Date.now() });
      return json(res, 200, { ok: true, mustChange: config.mustChangePassword }, { 'set-cookie': `panel_session=${token}; Path=/; HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
    }
    if (req.method === 'GET' && url.pathname === '/') { const s = session(req); return s ? send(res, 200, APP_HTML, 'text/html; charset=utf-8') : send(res, 302, '', 'text/plain', { location: '/login' }); }
    const s = requireAuth(req, res); if (!s) return;
    if (req.method === 'POST' && url.pathname === '/api/logout') { sessions.delete(cookies(req).panel_session); return json(res, 200, { ok: true }, { 'set-cookie': 'panel_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' }); }
    if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { ok: true, username: s.username, csrf: s.csrf, mustChange: config.mustChangePassword });
    if (req.method === 'GET' && url.pathname === '/api/state') { const mem = process.memoryUsage(); return json(res, 200, { ok: true, runningApps: [...runningApps.values()].filter(x => !x.killed).length, memory: `${Math.round(mem.rss / 1024 / 1024)} MB`, disk: 'see /data volume', hostname: os.hostname() }); }
    if (req.method === 'GET' && url.pathname === '/api/files') { const dir = safePath(url.searchParams.get('path') || '.'); const entries = await fsp.readdir(dir, { withFileTypes: true }); const items = []; for (const e of entries.sort((a,b)=>a.name.localeCompare(b.name))) { const full = path.join(dir, e.name); const st = e.isFile() ? await fsp.stat(full) : null; items.push({ name:e.name, path:relative(full), dir:e.isDirectory(), size:st?.size||0 }); } return json(res, 200, { ok:true, path:relative(dir), items }); }
    if (req.method === 'GET' && url.pathname === '/api/files/content') { const file = safePath(url.searchParams.get('path') || ''); const st = await fsp.stat(file); if (!st.isFile() || st.size > 2 * 1024 * 1024) throw new Error('Only text files up to 2 MB can be edited'); return json(res, 200, { ok:true, path:relative(file), content:await fsp.readFile(file,'utf8') }); }
    if (req.method === 'POST' && url.pathname === '/api/files/upload') { if (!requireChanged(s,res)) return; const file = safePath(url.searchParams.get('path') || ''); const data = await body(req, MAX_UPLOAD); await fsp.mkdir(path.dirname(file), {recursive:true}); await fsp.writeFile(file,data); return json(res,200,{ok:true,path:relative(file),bytes:data.length}); }
    if (req.method === 'POST' && url.pathname === '/api/files/save') { if (!requireChanged(s,res)) return; const input=await jsonBody(req); const file=safePath(input.path); if (String(input.content||'').length>2*1024*1024) throw new Error('File too large'); await fsp.mkdir(path.dirname(file),{recursive:true}); await fsp.writeFile(file,String(input.content||''),'utf8'); return json(res,200,{ok:true}); }
    if (req.method === 'POST' && url.pathname === '/api/files/delete') { if (!requireChanged(s,res)) return; const file=safePath((await jsonBody(req)).path); if (file===DATA_ROOT||file===PANEL_ROOT) throw new Error('Protected path'); await fsp.rm(file,{recursive:true,force:false}); return json(res,200,{ok:true}); }
    if (req.method === 'GET' && url.pathname === '/api/apps') return json(res,200,{ok:true,apps:apps.map(publicApp)});
    if (req.method === 'POST' && url.pathname === '/api/apps/create') { if (!requireChanged(s,res)) return; const x=await jsonBody(req); if(!/^[a-zA-Z0-9_-]{1,40}$/.test(x.name||'')) throw new Error('Invalid app name'); if(!x.command||String(x.command).length>600) throw new Error('Invalid command'); safePath(x.cwd||'.'); const app={id:randomToken(8),name:x.name,cwd:x.cwd||'.',command:String(x.command),env:x.env||{},createdAt:now()}; apps.push(app); await saveApps(); return json(res,200,{ok:true,app:publicApp(app)}); }
    if (req.method === 'POST' && /^\/api\/apps\/(start|stop|restart|delete)$/.test(url.pathname)) { if (!requireChanged(s,res)) return; const action=url.pathname.split('/').pop(); const {id}=await jsonBody(req); const app=appById(id); if(!app) throw new Error('App not found'); if(action==='start') startApp(app); if(action==='stop') stopApp(id); if(action==='restart'){stopApp(id);setTimeout(()=>startApp(app),700).unref()} if(action==='delete'){stopApp(id);apps=apps.filter(a=>a.id!==id);await saveApps()} return json(res,200,{ok:true}); }
    if (req.method === 'POST' && url.pathname === '/api/terminal') { if (!requireChanged(s,res)) return; const command=safeCommand((await jsonBody(req)).command); const child=spawn('bash',['-lc',command],{cwd:DATA_ROOT,env:process.env}); let output=''; const add=x=>{output=(output+x.toString()).slice(-64000)}; child.stdout.on('data',add);child.stderr.on('data',add); const result=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve({code:-1,timeout:true})},30000);child.on('close',code=>{clearTimeout(timer);resolve({code})})}); return json(res,200,{ok:true,command,output,exitCode:result.code,timeout:Boolean(result.timeout)}); }
    if (req.method === 'POST' && url.pathname === '/api/settings/credentials') { const x=await jsonBody(req); if(!verifyPassword(String(x.currentPassword||''),config.passwordHash)) throw new Error('رمز فعلی اشتباه است'); if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(x.username||'')) throw new Error('نام کاربری نامعتبر است'); if(String(x.password||'').length<8) throw new Error('رمز جدید باید حداقل ۸ کاراکتر باشد'); config.username=x.username;config.passwordHash=hashPassword(x.password);config.mustChangePassword=false;await saveConfig();s.username=config.username;return json(res,200,{ok:true,message:'اطلاعات ورود با موفقیت تغییر کرد'}); }
    return fail(res,404,'Not found');
  } catch (e) { console.error(e); return fail(res,400,e.message || 'Request failed'); }
}

init().then(() => http.createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`[panel] listening on 0.0.0.0:${PORT}`))).catch(err => { console.error(err); process.exit(1); });
process.on('SIGTERM',()=>{ for(const id of runningApps.keys()) stopApp(id); process.exit(0); });
