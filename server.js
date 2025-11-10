// server.js — Çoklu kiracı + Admin/Kullanıcı + TV menü + Inbox (izlenen klasör)
// Kurulum:
//   npm i express multer chokidar pdfjs-dist puppeteer cookie-parser jsonwebtoken
// Çalıştır: node server.js

const express      = require("express");
const path         = require("path");
const fs           = require("fs");
const fsp          = fs.promises;
const multer       = require("multer");
const chokidar     = require("chokidar");
const puppeteer    = require("puppeteer");
const cookieParser = require("cookie-parser");
const jwt          = require("jsonwebtoken");

const app  = express();
const PORT = process.env.PORT || 3000;

const ROOT    = __dirname;
const PUBLIC  = path.join(ROOT, "public");
const STORAGE = path.join(ROOT, "storage");

const SECRET      = process.env.JWT_SECRET  || "supersecret-menupanels";
const ADMIN_USER  = (process.env.ADMIN_USER || "admin").toLowerCase().trim();
const ADMIN_PASS  = (process.env.ADMIN_PASS || "admin9049").trim();

process.on("uncaughtException", e => console.error("[uncaught]", e));
process.on("unhandledRejection", e => console.error("[unhandled]", e));

for (const p of [PUBLIC, STORAGE]) if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });

const DB_FILE = path.join(STORAGE, "users.json");
async function loadDB(){ try{ return JSON.parse(await fsp.readFile(DB_FILE,"utf8")); } catch{ return {users:[]} } }
async function saveDB(db){ await fsp.writeFile(DB_FILE, JSON.stringify(db,null,2)); }

// ---- Tenant yolları
function tenantPaths(slug){
  const safe = String(slug||"").toLowerCase().replace(/[^a-z0-9_-]/g,"");
  const tRoot  = path.join(STORAGE,"tenants",safe);
  const tPub   = path.join(PUBLIC ,"tenants",safe);
  const pdf    = path.join(tRoot,"menu.pdf");
  const pngA   = path.join(tPub ,"menu_A.png");
  const pngB   = path.join(tPub ,"menu_B.png");
  const tmpIn  = path.join(tRoot,"__incoming");
  const inbox  = path.join(tRoot,"inbox");           // ✓ izlenen klasör
  return { safe,tRoot,tPub,pdf,pngA,pngB,tmpIn,inbox };
}
async function ensureTenantDirs(slug){
  const p = tenantPaths(slug);
  for (const d of [p.tRoot,p.tPub,p.tmpIn,p.inbox]) await fsp.mkdir(d,{recursive:true});
  return p;
}
function sanitizeName(name){
  return String(name||"").replace(/[/\\?%*:|"<>]/g,"").replace(/\.+/g,".").trim();
}

// ---- Genel middleware
app.disable("etag");
app.use((_,res,next)=>{ res.set("Cache-Control","no-store"); next(); });
app.use("/public", express.static(PUBLIC,{etag:false,index:false}));
app.use(express.static(PUBLIC,{etag:false,index:false})); // TV PNG’ler için kökten yayın
app.use(express.urlencoded({extended:true}));
app.use(express.json());
app.use(cookieParser());

// ---- pdf.js
const pdfjsDistPath = path.dirname(require.resolve("pdfjs-dist/package.json"));
app.use("/pdfjs", express.static(path.join(pdfjsDistPath,"build"), {
  setHeaders:(res,fp)=>{ if (fp.endsWith(".mjs")) res.type("text/javascript"); res.setHeader("Cache-Control","no-store"); }
}));

/* ==================== AUTH ==================== */
function sign(payload,key){ return jwt.sign(payload,key,{expiresIn:"7d"}); }
function verify(token,key){ try{ return jwt.verify(token,key); }catch{ return null; } }

function needAdmin(req,res,next){
  const data = verify(req.cookies.adm||"",SECRET);
  if (!data || data.role!=="admin") return res.redirect("/admin-login?e=1");
  req.admin=data; next();
}
function needUserFor(slugParam){
  return (req,res,next)=>{
    const data = verify(req.cookies.usr||"",SECRET);
    if (!data || data.role!=="user") return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    const slug = tenantPaths(req.params[slugParam]).safe;
    if (!slug || data.slug!==slug) return res.status(403).send("Bu panele erişim yetkiniz yok.");
    req.user=data; next();
  };
}

/* ==================== SAYFALAR ==================== */
app.get("/",(_req,res)=>{
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MenuPanels</title>
  <style>
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-20px)}}
  @keyframes gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
  @keyframes shimmer{0%{background-position:-1000px 0}100%{background-position:1000px 0}}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#eaecef;overflow-x:hidden}
  body{background:linear-gradient(135deg,#0a0a0f 0%,#1a1a2e 50%,#16213e 100%);background-size:400% 400%;animation:gradient 15s ease infinite;position:relative}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 20% 50%,rgba(59,130,246,0.1) 0%,transparent 50%),radial-gradient(circle at 80% 80%,rgba(99,102,241,0.1) 0%,transparent 50%);pointer-events:none;z-index:0}
  .wrap{max-width:900px;margin:0 auto;padding:40px 20px;min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;z-index:1}
  .card{background:rgba(21,22,26,0.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:24px;padding:48px;box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.05) inset;width:100%;animation:float 6s ease-in-out infinite}
  h1{font-size:42px;font-weight:800;background:linear-gradient(135deg,#60a5fa 0%,#3b82f6 50%,#8b5cf6 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:16px;letter-spacing:-1px}
  p{color:rgba(255,255,255,0.7);font-size:18px;margin-bottom:32px;line-height:1.6}
  .btn-wrap{display:flex;gap:16px;flex-wrap:wrap}
  a.btn{display:inline-flex;align-items:center;justify-content:center;padding:16px 32px;border-radius:14px;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff;text-decoration:none;font-weight:600;font-size:15px;transition:all 0.3s cubic-bezier(0.4,0,0.2,1);box-shadow:0 4px 14px rgba(59,130,246,0.4);position:relative;overflow:hidden}
  a.btn::before{content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);transition:left 0.5s}
  a.btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(59,130,246,0.6)}
  a.btn:hover::before{left:100%}
  a.btn:active{transform:translateY(0)}
  a.btn.secondary{background:linear-gradient(135deg,#6b7280 0%,#4b5563 100%);box-shadow:0 4px 14px rgba(107,114,128,0.3)}
  a.btn.secondary:hover{box-shadow:0 8px 24px rgba(107,114,128,0.5)}
  </style>
  <div class="wrap">
    <div class="card">
      <h1>MenuPanels</h1>
      <p>PDF yükle → TV'ye anında yansısın. Modern menü yönetim sistemi.</p>
      <div class="btn-wrap">
        <a class="btn" href="/login">Kullanıcı Girişi</a>
        <a class="btn secondary" href="/admin-login">Admin Girişi</a>
      </div>
    </div>
  </div>`);
});

// Admin login (GET) — hızlı kapı
app.get("/admin-login",(req,res)=>{
  const qp=(req.query.pw||"").trim();
  if (qp && qp===ADMIN_PASS){ res.cookie("adm",sign({role:"admin",u:ADMIN_USER},SECRET),{httpOnly:true,sameSite:"Lax"}); return res.redirect("/admin"); }
  const err=req.query.e?`<div style='color:#f87171;font-weight:600;padding:12px;background:rgba(248,113,113,0.1);border-radius:10px;margin-bottom:16px;border:1px solid rgba(248,113,113,0.2)'>Hatalı giriş bilgileri.</div>`:"";
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Girişi</title>
  <style>
  @keyframes gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
  @keyframes slideIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{margin:0;min-height:100vh;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#0a0a0f 0%,#1a1a2e 50%,#16213e 100%);background-size:400% 400%;animation:gradient 15s ease infinite;color:#eaecef;display:flex;align-items:center;justify-content:center;padding:20px;position:relative}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 20% 50%,rgba(59,130,246,0.1) 0%,transparent 50%),radial-gradient(circle at 80% 80%,rgba(99,102,241,0.1) 0%,transparent 50%);pointer-events:none}
  .box{max-width:440px;width:100%;background:rgba(21,22,26,0.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,0.5);animation:slideIn 0.5s ease-out;position:relative;z-index:1}
  h2{font-size:28px;font-weight:700;margin-bottom:8px;background:linear-gradient(135deg,#60a5fa 0%,#3b82f6 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  input,button{width:100%;padding:14px 18px;border-radius:12px;border:1px solid rgba(255,255,255,0.1);background:rgba(15,16,19,0.6);color:#eaecef;font-size:15px;transition:all 0.3s ease;font-family:inherit}
  input:focus{outline:none;border-color:#3b82f6;background:rgba(15,16,19,0.8);box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
  input::placeholder{color:rgba(255,255,255,0.4)}
  button{margin-top:16px;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);border:0;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(59,130,246,0.4);position:relative;overflow:hidden}
  button::before{content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);transition:left 0.5s}
  button:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(59,130,246,0.6)}
  button:hover::before{left:100%}
  button:active{transform:translateY(0)}
  </style>
  <div class="box">
    <h2>Admin Girişi</h2>
    <p style="color:rgba(255,255,255,0.6);margin-bottom:24px;font-size:14px">Yönetim paneline erişim için giriş yapın</p>
    ${err}
    <form method="post" action="/auth/admin">
      <input name="u" placeholder="Kullanıcı adı" required autocomplete="username">
      <input name="p" placeholder="Şifre" type="password" required autocomplete="current-password" style="margin-top:12px">
      <button type="submit">Giriş Yap</button>
    </form>
  </div>`);
});
app.post("/auth/admin",(req,res)=>{
  const u=(req.body?.u||"").toLowerCase().trim(); const p=(req.body?.p||"").trim();
  if (u===ADMIN_USER && p===ADMIN_PASS){ res.cookie("adm",sign({role:"admin",u},SECRET),{httpOnly:true,sameSite:"Lax"}); return res.redirect("/admin"); }
  res.redirect("/admin-login?e=1");
});

// Kullanıcı login
app.get("/login",(req,res)=>{
  const err=req.query.e?`<div style='color:#f87171;font-weight:600;padding:12px;background:rgba(248,113,113,0.1);border-radius:10px;margin-bottom:16px;border:1px solid rgba(248,113,113,0.2)'>Hatalı giriş bilgileri.</div>`:"";
  const next=req.query.next?`<input type="hidden" name="next" value="${String(req.query.next)}">`:"";
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kullanıcı Girişi</title>
  <style>
  @keyframes gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
  @keyframes slideIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{margin:0;min-height:100vh;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#0a0a0f 0%,#1a1a2e 50%,#16213e 100%);background-size:400% 400%;animation:gradient 15s ease infinite;color:#eaecef;display:flex;align-items:center;justify-content:center;padding:20px;position:relative}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 20% 50%,rgba(59,130,246,0.1) 0%,transparent 50%),radial-gradient(circle at 80% 80%,rgba(99,102,241,0.1) 0%,transparent 50%);pointer-events:none}
  .box{max-width:440px;width:100%;background:rgba(21,22,26,0.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:40px;box-shadow:0 20px 60px rgba(0,0,0,0.5);animation:slideIn 0.5s ease-out;position:relative;z-index:1}
  h2{font-size:28px;font-weight:700;margin-bottom:8px;background:linear-gradient(135deg,#60a5fa 0%,#3b82f6 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  input,button{width:100%;padding:14px 18px;border-radius:12px;border:1px solid rgba(255,255,255,0.1);background:rgba(15,16,19,0.6);color:#eaecef;font-size:15px;transition:all 0.3s ease;font-family:inherit}
  input:focus{outline:none;border-color:#3b82f6;background:rgba(15,16,19,0.8);box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
  input::placeholder{color:rgba(255,255,255,0.4)}
  input[type="password"]{margin-top:12px}
  button{margin-top:16px;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);border:0;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(59,130,246,0.4);position:relative;overflow:hidden}
  button::before{content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);transition:left 0.5s}
  button:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(59,130,246,0.6)}
  button:hover::before{left:100%}
  button:active{transform:translateY(0)}
  </style>
  <div class="box">
    <h2>Kullanıcı Girişi</h2>
    <p style="color:rgba(255,255,255,0.6);margin-bottom:24px;font-size:14px">Menü yönetim paneline erişim için giriş yapın</p>
    ${err}
    <form method="post" action="/auth/user">
      <input name="slug" placeholder="Mağaza kodu (slug)" required autocomplete="username">
      <input name="u" placeholder="Kullanıcı adı" required autocomplete="username" style="margin-top:12px">
      <input name="p" placeholder="Şifre" type="password" required autocomplete="current-password" style="margin-top:12px">
      ${next}
      <button type="submit">Giriş Yap</button>
    </form>
  </div>`);
});
app.post("/auth/user",async (req,res)=>{
  const {slug,u,p,next}=req.body||{}; const db=await loadDB();
  const user = db.users.find(x=>x.slug===String(slug).toLowerCase() && x.username===u && x.password===p);
  if(!user) return res.redirect("/login?e=1");
  res.cookie("usr",sign({role:"user",slug:user.slug,u:user.username},SECRET),{httpOnly:true,sameSite:"Lax"});
  res.redirect(next || `/panel/${user.slug}`);
});

app.get("/logout",(req,res)=>{ res.clearCookie("adm"); res.clearCookie("usr"); res.redirect("/"); });

/* ==================== ADMIN PANEL ==================== */
app.get("/admin",needAdmin,async (_req,res)=>{
  const db=await loadDB();
  const rows=db.users.map(u=>`<tr><td><strong>${u.slug}</strong></td><td>${u.username}</td><td><code>${u.password}</code></td>
  <td><form method="post" action="/admin/delete/${u.slug}" onsubmit="return confirm('Silinsin mi?')" style="margin:0"><button class="btn-del">Sil</button></form></td></tr>`).join("");
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Paneli</title>
  <style>
  @keyframes gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
  @keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{margin:0;min-height:100vh;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#0a0a0f 0%,#1a1a2e 50%,#16213e 100%);background-size:400% 400%;animation:gradient 15s ease infinite;color:#eaecef;padding:40px 20px;position:relative}
  body::before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 20% 50%,rgba(59,130,246,0.08) 0%,transparent 50%),radial-gradient(circle at 80% 80%,rgba(99,102,241,0.08) 0%,transparent 50%);pointer-events:none;z-index:0}
  .wrap{max-width:1000px;margin:0 auto;position:relative;z-index:1}
  .card{background:rgba(21,22,26,0.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:32px;box-shadow:0 20px 60px rgba(0,0,0,0.5);animation:fadeIn 0.6s ease-out}
  h2{font-size:32px;font-weight:800;margin-bottom:8px;background:linear-gradient(135deg,#60a5fa 0%,#3b82f6 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .form-row{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
  input,button{padding:12px 16px;border-radius:12px;border:1px solid rgba(255,255,255,0.1);background:rgba(15,16,19,0.6);color:#eaecef;font-size:14px;transition:all 0.3s ease;font-family:inherit;flex:1;min-width:180px}
  input:focus{outline:none;border-color:#3b82f6;background:rgba(15,16,19,0.8);box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
  button{background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);border:0;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(59,130,246,0.4);flex:0 0 auto}
  button:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(59,130,246,0.6)}
  button.btn-del{background:linear-gradient(135deg,#ef4444 0%,#dc2626 100%);box-shadow:0 4px 14px rgba(239,68,68,0.4);padding:8px 16px;font-size:13px}
  button.btn-del:hover{box-shadow:0 8px 24px rgba(239,68,68,0.6)}
  table{width:100%;border-collapse:collapse;margin-top:24px;background:rgba(15,16,19,0.3);border-radius:12px;overflow:hidden}
  th,td{padding:14px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.05)}
  th{background:rgba(59,130,246,0.1);font-weight:600;color:#60a5fa;font-size:13px;text-transform:uppercase;letter-spacing:0.5px}
  tr:hover{background:rgba(255,255,255,0.02)}
  code{background:rgba(0,0,0,0.3);padding:4px 8px;border-radius:6px;font-family:'Courier New',monospace;font-size:13px;color:#9fe870}
  a{color:#60a5fa;text-decoration:none;font-weight:500;transition:color 0.3s}
  a:hover{color:#93c5fd}
  .info{color:rgba(255,255,255,0.6);font-size:13px;margin-top:20px;padding:16px;background:rgba(59,130,246,0.05);border-radius:10px;border-left:3px solid #3b82f6}
  </style>
  <div class="wrap">
    <div class="card">
      <h2>Admin Paneli</h2>
      <p style="color:rgba(255,255,255,0.6);margin-bottom:24px">Kullanıcı ekle ve yönet. Her kullanıcı kendi slug'ı ile panel ve TV sayfasına sahip olur.</p>
      <form method="post" action="/admin/add" class="form-row">
        <input name="slug" placeholder="slug (ör. kebapciahmet)" required>
        <input name="username" placeholder="kullanıcı adı" required>
        <input name="password" placeholder="şifre" required>
        <button type="submit">Ekle</button>
      </form>
      <table>
        <thead><tr><th>Slug</th><th>Kullanıcı</th><th>Şifre</th><th>İşlem</th></tr></thead>
        <tbody>${rows||"<tr><td colspan=4 style='text-align:center;color:rgba(255,255,255,0.5);padding:40px'>Henüz kullanıcı kaydı yok</td></tr>"}</tbody>
      </table>
      <div class="info">
        <strong>Bilgi:</strong> Panel: <code>/panel/&lt;slug&gt;</code> — TV: <code>/t/&lt;slug&gt;</code> — PDF: <code>/menu/&lt;slug&gt;.pdf</code>
      </div>
      <p style="margin-top:20px"><a href="/logout">Çıkış Yap</a></p>
    </div>
  </div>`);
});
app.post("/admin/add",needAdmin,async (req,res)=>{
  const slug=String(req.body.slug||"").toLowerCase().replace(/[^a-z0-9_-]/g,"");
  if(!slug) return res.redirect("/admin");
  const db=await loadDB(); if (db.users.find(u=>u.slug===slug)) return res.redirect("/admin");
  db.users.push({slug,username:req.body.username,password:req.body.password}); await saveDB(db); await ensureTenantDirs(slug); res.redirect("/admin");
});
app.post("/admin/delete/:slug",needAdmin,async (req,res)=>{
  const slug=req.params.slug; const db=await loadDB(); db.users=db.users.filter(u=>u.slug!==slug); await saveDB(db); res.redirect("/admin");
});

/* ==================== PANEL (KULLANICI) ==================== */
function panelHtml(slug){
  return `<!doctype html><html lang="tr"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Menü Yönetimi – ${slug}</title>
<style>
@keyframes gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes fadeIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideIn{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
:root{ color-scheme: dark light; }
*{ box-sizing:border-box; margin:0; padding:0 }
body{ margin:0; font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:#eaecef;
  background:linear-gradient(135deg,#0a0a0f 0%,#1a1a2e 50%,#16213e 100%);background-size:400% 400%;animation:gradient 15s ease infinite;
  min-height:100vh; padding:40px 20px; position:relative; }
body::before{content:'';position:fixed;inset:0;background:radial-gradient(circle at 20% 50%,rgba(59,130,246,0.1) 0%,transparent 50%),radial-gradient(circle at 80% 80%,rgba(99,102,241,0.1) 0%,transparent 50%);pointer-events:none;z-index:0}
.wrap{ max-width:1000px; margin:0 auto; position:relative; z-index:1 }
.card{ background:rgba(21,22,26,0.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:24px;
  box-shadow:0 20px 60px rgba(0,0,0,0.5); padding:40px; animation:fadeIn 0.6s ease-out }
h2{font-size:32px;font-weight:800;margin-bottom:24px;background:linear-gradient(135deg,#60a5fa 0%,#3b82f6 50%,#8b5cf6 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-0.5px}
h3{font-size:20px;font-weight:700;margin-bottom:16px;color:#eaecef;display:flex;align-items:center;gap:8px}
h3::before{content:'';width:4px;height:20px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border-radius:2px}
.section{ background:rgba(15,16,19,0.5);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:24px;margin:20px 0;
  transition:all 0.3s ease;animation:slideIn 0.4s ease-out }
.section:hover{border-color:rgba(59,130,246,0.3);box-shadow:0 4px 20px rgba(59,130,246,0.1)}
.grid3{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px } @media (max-width:820px){ .grid3{ grid-template-columns:1fr } }
.btn{ appearance:none; border:0; cursor:pointer; padding:12px 20px; border-radius:12px; font-weight:600; font-size:14px;
  background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%); color:#fff; text-decoration:none; display:inline-block; text-align:center;
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1); box-shadow:0 4px 14px rgba(59,130,246,0.4); position:relative; overflow:hidden }
.btn::before{content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent);transition:left 0.5s}
.btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(59,130,246,0.6)}
.btn:hover::before{left:100%}
.btn:active{transform:translateY(0)}
.btn.mini{ padding:8px 14px; font-size:12px; border-radius:10px }
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}
.muted{color:rgba(255,255,255,0.6);font-size:14px} .ok{color:#9fe870;font-weight:600;font-size:14px}
input[type="file"]{padding:10px 16px;border-radius:12px;background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);border:0;color:#fff;cursor:pointer;transition:all 0.3s;font-weight:600;font-size:14px;box-shadow:0 4px 14px rgba(59,130,246,0.4);position:relative;overflow:hidden}
input[type="file"]::file-selector-button{display:none}
input[type="file"]:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(59,130,246,0.6)}
input[type="file"]:active{transform:translateY(0)}
label.btn{background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff!important;border:0;cursor:pointer;padding:10px 16px;border-radius:12px;font-weight:600;font-size:14px;box-shadow:0 4px 14px rgba(59,130,246,0.4);transition:all 0.3s;display:inline-block;text-align:center}
label.btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(59,130,246,0.6)}
label.btn:active{transform:translateY(0)}
table{width:100%;border-collapse:collapse;margin-top:16px;background:rgba(15,16,19,0.3);border-radius:12px;overflow:hidden}
th,td{padding:12px;border-bottom:1px solid rgba(255,255,255,0.05);text-align:left}
th{background:rgba(59,130,246,0.1);font-weight:600;color:#60a5fa;font-size:13px;text-transform:uppercase;letter-spacing:0.5px}
tr:hover{background:rgba(255,255,255,0.02);transition:background 0.2s}
td.actions{white-space:nowrap;display:flex;gap:6px;flex-wrap:wrap}
td.actions .btn{font-size:12px;padding:6px 12px}
.drop{border:2px dashed rgba(59,130,246,0.3);border-radius:14px;padding:24px;text-align:center;color:rgba(255,255,255,0.6);
  background:rgba(59,130,246,0.03);transition:all 0.3s;cursor:pointer}
.drop:hover{border-color:rgba(59,130,246,0.6);background:rgba(59,130,246,0.08);transform:scale(1.01)}
.drop.dragover{border-color:#3b82f6;background:rgba(59,130,246,0.15);animation:pulse 1s ease-in-out infinite}
#stat{font-size:13px;color:rgba(255,255,255,0.5);margin-top:20px;padding:12px;background:rgba(59,130,246,0.05);border-radius:10px;border-left:3px solid #3b82f6}
</style></head><body>
<div class="wrap"><div class="card">
  <h2>Menü Yönetimi – ${slug}</h2>
  <div class="section">
    <h3>PDF Yükle</h3>
    <form id="up" action="/upload/${slug}" method="post" enctype="multipart/form-data">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="file" id="fileInput" name="pdf" accept="application/pdf,.pdf" required style="display:none" />
        <label for="fileInput" class="btn" style="margin:0;cursor:pointer">Dosya Seç</label>
        <span id="fileName" class="muted" style="flex:1;min-width:200px">Dosya seçilmedi</span>
        <button class="btn" type="submit">Yükle ve Kaydet</button>
      </div>
    </form>
    <div class="muted" style="margin-top:12px">Dosya yolu: <b>storage/tenants/${slug}/menu.pdf</b></div>
    <p id="msg" class="ok"></p>
  </div>

  <div class="section">
    <h3>TV / İşlemler</h3>
    <div class="grid3">
      <a class="btn" href="/t/${slug}" target="_blank" rel="noopener">TV’yi Aç</a>
      <a class="btn" href="https://www.canva.com/tr_tr/pdf-duzenleyici" target="_blank" rel="noopener">Web’de Düzenle</a>
      <a class="btn" href="/panel-edit/${slug}" target="_blank" rel="noopener">Panelde Düzenle (Fiyat)</a>
    </div>
    <p id="hint" class="muted" style="margin-top:12px"></p>
  </div>

  <div class="section">
    <h3>İzlenen Klasör (Inbox)</h3>
    <p class="muted">Bu klasöre eklediğiniz PDF’ler aşağıda listelenir. “Yayına Al” derseniz <b>menu.pdf</b> olarak kullanılır ve TV güncellenir.</p>

     <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-bottom:6px">
       <button class="btn mini" id="btnInboxReload" type="button">Yenile</button>
       <span id="iboxHint" class="muted"></span>
     </div>

    <div class="drop" id="drop">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center">
        <span>Sürükleyip bırakın veya</span>
        <input id="many" type="file" accept="application/pdf" multiple style="display:none">
        <label for="many" class="btn" style="margin:0;cursor:pointer">Dosyaları Seç</label>
        <span>/</span>
        <label class="btn" for="pickFolder" style="margin:0;cursor:pointer">Klasör Seç</label>
        <input id="pickFolder" type="file" accept="application/pdf" webkitdirectory directory multiple style="display:none">
      </div>
    </div>

    <table style="margin-top:12px">
      <thead><tr><th>Dosya</th><th>Boyut</th><th>Tarih</th><th></th></tr></thead>
      <tbody id="inbox"></tbody>
    </table>
  </div>

  <div class="muted" id="stat">Sistem aktif.</div>
  <p style="margin-top:10px"><a class="btn" href="/logout">Çıkış</a></p>
</div></div>

<script>
const slug=${JSON.stringify(slug)};
(function(){ const p=new URLSearchParams(location.search); if(p.get('ok')){document.getElementById('msg').textContent='PDF yüklendi. PNG üretiliyor; TV yenilenecek.'; history.replaceState(null,'',location.pathname);} })();

// Dosya seçildiğinde adını göster
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
if(fileInput && fileName){
  fileInput.addEventListener('change', function(e){
    if(e.target.files && e.target.files.length > 0){
      fileName.textContent = e.target.files[0].name;
      fileName.style.color = '#9fe870';
    } else {
      fileName.textContent = 'Dosya seçilmedi';
      fileName.style.color = 'rgba(255,255,255,0.6)';
    }
  });
}

const hint=document.getElementById('hint');
async function callPOST(url,body){ try{ const r=await fetch(url,{method:'POST',body}); return r.ok; }catch{ return false; } }

function fmt(n){ if(n==null) return '-'; const u=['B','KB','MB','GB']; let i=0; let x=n; while(x>=1024 && i<u.length-1){ x/=1024; i++; } return x.toFixed( (i?1:0) )+' '+u[i]; }
function rowHTML(f){ return \`<tr><td>\${f.name}</td><td>\${fmt(f.size)}</td><td>\${new Date(f.mtime).toLocaleString()}</td>
<td class="actions"><a class="btn" href="/api/inbox/\${slug}/file/\${encodeURIComponent(f.name)}" target="_blank">İndir/Gör</a>
<button class="btn" onclick="activate('\${encodeURIComponent(f.name)}')">Yayına Al</button>
<button class="btn" onclick="delFile('\${encodeURIComponent(f.name)}')">Sil</button></td></tr>\`; }

async function loadInbox(){
  try {
    // Timestamp + random ile cache'i tamamen bypass et
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const url = '/api/inbox/'+slug+'?t='+timestamp+'&_='+random+'&r='+Date.now();
    
    const r = await fetch(url, { 
      method: 'GET',
      cache: 'no-store',
      headers: { 
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    
    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }
    
    const j = await r.json();
    const tbody = document.getElementById('inbox');
    if (tbody) {
      tbody.innerHTML = j.files && j.files.length > 0 
        ? j.files.map(rowHTML).join('') 
        : '<tr><td colspan="4" class="muted">Klasör boş</td></tr>';
    }
    console.log('[loadInbox] Yüklendi:', j.count || 0, 'dosya');
  } catch(e) {
    console.error('Inbox yükleme hatası:', e);
    const tbody = document.getElementById('inbox');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted" style="color:#f87171">Yükleme hatası: ' + (e.message || 'Bilinmeyen') + '</td></tr>';
    }
  }
}
window.activate=async (name)=>{ 
  const ok=await callPOST('/api/inbox/'+slug+'/activate?name='+name); 
  // Cache bypass ile yenile
  const r = await fetch('/api/inbox/'+slug+'?t='+Date.now()+'&_='+Math.random(), { 
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
  });
  const j = await r.json();
  document.getElementById('inbox').innerHTML =
    j.files.map(rowHTML).join('') || '<tr><td colspan="4" class="muted">Klasör boş</td></tr>';
  if(ok){ hint.textContent='Yayına alındı, TV güncellenecek.'; setTimeout(()=>hint.textContent='',2200); } 
};
window.delFile=async (name)=>{ 
  if(!confirm('Silinsin mi?')) return; 
  const r=await fetch('/api/inbox/'+slug+'/delete?name='+name,{method:'DELETE'}); 
  // Cache bypass ile yenile
  const r2 = await fetch('/api/inbox/'+slug+'?t='+Date.now()+'&_='+Math.random(), { 
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
  });
  const j = await r2.json();
  document.getElementById('inbox').innerHTML =
    j.files.map(rowHTML).join('') || '<tr><td colspan="4" class="muted">Klasör boş</td></tr>';
};

const drop=document.getElementById('drop'); const many=document.getElementById('many');
function doUpload(files){
  if(!files || !files.length) return;
  const fd=new FormData();
  for(const f of files) fd.append('files',f);
  fetch('/api/inbox/'+slug+'/upload',{method:'POST',body:fd})
    .then(()=>{
      // Upload sonrası cache bypass ile yenile
      setTimeout(() => {
        const r = fetch('/api/inbox/'+slug+'?t='+Date.now()+'&_='+Math.random(), { 
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
        }).then(r => r.json()).then(j => {
          document.getElementById('inbox').innerHTML =
            j.files.map(rowHTML).join('') || '<tr><td colspan="4" class="muted">Klasör boş</td></tr>';
        }).catch(() => {});
      }, 500); // Kısa bir gecikme ile dosya sisteminin güncellenmesini bekle
    })
    .catch(()=>loadInbox());
}
drop.addEventListener('dragover',e=>{e.preventDefault(); drop.classList.add('dragover');}); 
drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));
drop.addEventListener('drop',e=>{e.preventDefault(); drop.classList.remove('dragover'); doUpload(e.dataTransfer.files);}); 
many.onchange=e=>doUpload(e.target.files);

// File System Access API ile klasör erişimi (modern tarayıcılar)
let folderHandle = null;
const ibHint = document.getElementById('iboxHint');

// Klasör seçimi - File System Access API kullan
async function selectFolder() {
  if (!window.showDirectoryPicker) {
    // Fallback: Eski yöntem (webkitdirectory)
    const pickFolder = document.getElementById('pickFolder');
    pickFolder.click();
    return;
  }
  
  try {
    folderHandle = await window.showDirectoryPicker();
    ibHint.textContent = 'Klasör seçildi ✓';
    ibHint.style.color = '#9fe870';
    setTimeout(() => { ibHint.textContent = ''; }, 2000);
    // Klasör seçildiğinde hemen listele
    await readFolderAndList();
  } catch(e) {
    if (e.name !== 'AbortError') {
      console.error('Klasör seçimi hatası:', e);
      ibHint.textContent = 'Klasör seçimi iptal edildi';
      ibHint.style.color = '#f87171';
      setTimeout(() => { ibHint.textContent = ''; }, 2000);
    }
  }
}

// Klasörden dosyaları oku ve listele
async function readFolderAndList() {
  if (!folderHandle) {
    ibHint.textContent = 'Önce klasör seçin';
    ibHint.style.color = '#f87171';
    setTimeout(() => { ibHint.textContent = ''; }, 2000);
    return;
  }
  
  ibHint.textContent = 'Klasör okunuyor...';
  ibHint.style.color = '#9aa0a6';
  
  try {
    const fd = new FormData();
    let pdfCount = 0;
    
    // Klasördeki tüm dosyaları oku
    for await (const entry of folderHandle.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
        const file = await entry.getFile();
        fd.append('files', file);
        pdfCount++;
      }
    }
    
    if (pdfCount === 0) {
      ibHint.textContent = 'Klasörde PDF bulunamadı';
      ibHint.style.color = '#f87171';
      setTimeout(() => { ibHint.textContent = ''; }, 2000);
      return;
    }
    
    // PDF'leri yükle
    const uploadRes = await fetch('/api/inbox/'+slug+'/upload', { method: 'POST', body: fd });
    if (uploadRes.ok) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await loadInbox();
      ibHint.textContent = pdfCount + ' PDF yüklendi ve listelendi ✓';
      ibHint.style.color = '#9fe870';
    } else {
      throw new Error('Yükleme başarısız');
    }
  } catch(e) {
    console.error('Klasör okuma hatası:', e);
    ibHint.textContent = 'Hata: ' + (e.message || 'Bilinmeyen hata');
    ibHint.style.color = '#f87171';
  }
  
  setTimeout(() => { ibHint.textContent = ''; }, 3000);
}

// Eski yöntem için fallback (webkitdirectory)
const pickFolder = document.getElementById('pickFolder');
pickFolder.onchange = async (e) => { 
  const files = e.target.files;
  if (!files || files.length === 0) {
    pickFolder.value = "";
    return;
  }
  
  ibHint.textContent = 'Klasör seçildi, yükleniyor...';
  ibHint.style.color = '#9aa0a6';
  
  const fd = new FormData();
  for (const f of files) {
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      fd.append('files', f);
    }
  }
  
  try {
    const uploadRes = await fetch('/api/inbox/'+slug+'/upload', { method: 'POST', body: fd });
    if (uploadRes.ok) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await loadInbox();
      ibHint.textContent = 'Yüklendi ve listelendi ✓';
      ibHint.style.color = '#9fe870';
    } else {
      throw new Error('Yükleme başarısız');
    }
  } catch(e) {
    console.error('Yükleme hatası:', e);
    ibHint.textContent = 'Yükleme hatası!';
    ibHint.style.color = '#f87171';
  }
  
  setTimeout(() => { ibHint.textContent = ''; }, 2000);
  pickFolder.value = "";
};

// "Klasör Seç" butonu
document.querySelector('label[for="pickFolder"]').onclick = (e) => {
  e.preventDefault();
  selectFolder();
};

// "Yenile" butonu - aynı klasörden devam et, sadece izin iste
document.getElementById('btnInboxReload').onclick = async () => {
  if (!folderHandle) {
    // İlk seferinde klasör seç
    ibHint.textContent = 'Önce klasör seçin';
    ibHint.style.color = '#9aa0a6';
    await selectFolder();
    return;
  }
  
  // Aynı klasörden devam et - sadece izin iste
  try {
    // Klasör erişimini kontrol et (izin gerekebilir)
    const permission = await folderHandle.requestPermission({ mode: 'read' });
    if (permission === 'granted') {
      await readFolderAndList();
    } else {
      ibHint.textContent = 'Klasör erişim izni reddedildi';
      ibHint.style.color = '#f87171';
      setTimeout(() => { ibHint.textContent = ''; }, 2000);
    }
  } catch(e) {
    // İzin hatası - klasörü tekrar seç
    console.log('İzin hatası, klasör tekrar seçiliyor:', e);
    folderHandle = null;
    await selectFolder();
  }
};

async function ping(){ try{ const r=await fetch('/health',{cache:'no-store'}); if(r.ok){ const j=await r.json(); document.getElementById('stat').textContent='Sistem aktif – son kontrol: '+new Date(j.ts).toLocaleTimeString(); } }catch{} }
// İlk yükleme
loadInbox(); 
// Otomatik yenileme - her 5 saniyede bir (cache bypass ile)
setInterval(() => {
  const r = fetch('/api/inbox/'+slug+'?t='+Date.now(), { 
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
  }).then(r => r.json()).then(j => {
    document.getElementById('inbox').innerHTML =
      j.files.map(rowHTML).join('') || '<tr><td colspan="4" class="muted">Klasör boş</td></tr>';
  }).catch(() => {});
}, 5000);
ping(); setInterval(ping,15000);
</script></body></html>`;
}

app.get("/panel/:slug", needUserFor("slug"), async (req,res)=>{ await ensureTenantDirs(req.params.slug); res.send(panelHtml(req.params.slug)); });

// Basit fiyat düzenleyici (PDF.js + pdf-lib ile inline düzenleme)
function editorHtml(slug){
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fiyat Düzenleyici – ${slug}</title>
  <style>
  :root{color-scheme:dark light}*{box-sizing:border-box}
  body{margin:0;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#eaecef;
    background:linear-gradient(135deg,#0a0a0f 0%,#1a1a2e 50%,#16213e 100%);background-size:400% 400%}
  .bar{position:sticky;top:0;z-index:10;display:flex;gap:10px;align-items:center;padding:12px 16px;background:rgba(21,22,26,.75);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.08)}
  .btn{appearance:none;border:0;border-radius:10px;padding:10px 14px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-weight:600;cursor:pointer}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .wrap{max-width:1000px;margin:12px auto;padding:0 12px}
  .page{position:relative;margin:14px auto;background:#111;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.35);overflow:hidden}
  canvas{display:block;width:100%;height:auto}
  .hit{position:absolute;transform:translate(-2px,-2px);padding:2px 4px;border-radius:6px;background:rgba(0,0,0,.45);border:1px dashed rgba(255,255,255,.3)}
  .hit input{width:120px;max-width:140px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);outline:none;color:#fff;border-radius:6px;padding:4px 6px}
  .muted{color:rgba(255,255,255,.7)}
  </style>
  <div class="bar">
    <button id="btnSave" class="btn">Kaydet ve Yayına Al</button>
    <a class="btn" href="/panel/${slug}">Panele Dön</a>
    <span id="info" class="muted" style="margin-left:auto"></span>
  </div>
  <div class="wrap" id="wrap"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>
  <script>
  const slug=${JSON.stringify(slug)};
  const pdfUrl='/menu/'+slug+'.pdf';
  const priceRegex=/(?:₺\\s*)?(?:\\d{1,3}(?:[.,]\\d{3})*|\\d+)(?:[.,]\\d{2})?\\s*(?:₺|TL)?/;
  const hits=[]; // {pageIndex,x,y,fontSize,value,input}
  const wrap=document.getElementById('wrap'); const info=document.getElementById('info'); const btn=document.getElementById('btnSave');
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  (async function init(){
    try{
      const loading=await pdfjsLib.getDocument(pdfUrl).promise;
      const total=loading.numPages;
      info.textContent='PDF yükleniyor...';
      for(let i=1;i<=total;i++){
        const page=await loading.getPage(i);
        const viewport=page.getViewport({scale:1.5});
        const pageDiv=document.createElement('div'); pageDiv.className='page'; pageDiv.style.width=viewport.width+'px';
        const canvas=document.createElement('canvas'); const ctx=canvas.getContext('2d'); canvas.width=viewport.width; canvas.height=viewport.height; pageDiv.appendChild(canvas);
        wrap.appendChild(pageDiv);
        await page.render({canvasContext:ctx,viewport}).promise;
        const txt=await page.getTextContent();
        const vtf=viewport.transform;
        const ph=viewport.height;
        txt.items.forEach(it=>{
          const t=pdfjsLib.Util.transform(vtf,it.transform);
          const x=t[4], y=t[5]; // PDF units scaled by viewport
          const top=ph - y;
          const str=(it.str||'').trim();
          if(!str) return;
          if(priceRegex.test(str)){
            const fontSize=Math.abs(t[3]||12);
            const el=document.createElement('div'); el.className='hit'; el.style.left=x+'px'; el.style.top=(top-fontSize)+'px';
            const input=document.createElement('input'); input.value=str.replace(/\\s+/g,' ');
            el.appendChild(input); pageDiv.appendChild(el);
            // PDF-lib çizimi için PDF biriminde değerleri sakla.
            hits.push({
              pageIndex:i-1,
              xPdf:x/viewport.scale,        // soldan mesafe (PDF birimi)
              yTopPdf:y/viewport.scale,     // üstten mesafe (PDF birimi)
              fontSizePdf:fontSize/viewport.scale,
              value:str,
              input
            });
          }
        });
      }
      info.textContent='Bulunan fiyat alanları: '+hits.length+'. Değerleri değiştirip "Kaydet"e basın.';
    }catch(e){ info.textContent='PDF yüklenemedi.'; console.error(e); }
  })();
  btn.onclick=async ()=>{
    try{
      btn.disabled=true; info.textContent='PDF güncelleniyor...';
      const ab=await fetch(pdfUrl,{cache:'no-store'}).then(r=>r.arrayBuffer());
      const pdf=await PDFLib.PDFDocument.load(ab);
      const helv=await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
      // Sadece değişen alanları yaz
      for(const h of hits){
        const newVal=(h.input.value||'').trim();
        if(!newVal || newVal===h.value) continue;
        const page=pdf.getPages()[h.pageIndex];
        const pageH=page.getHeight();
        // pdf-lib alt-sol orijin: y'yi dönüştür (üstten mesafe -> alt orijin)
        const x=h.xPdf;
        const y=pageH - h.yTopPdf - h.fontSizePdf;
        // Eski fiyatın üstünü kapat (zemin siyah varsayımı)
        const oldW=helv.widthOfTextAtSize(h.value, h.fontSizePdf);
        const newW=helv.widthOfTextAtSize(newVal, h.fontSizePdf);
        const coverW=Math.max(oldW,newW)+8;
        const coverH=h.fontSizePdf*1.3;
        page.drawRectangle({x:x-4,y:y-2,width:coverW,height:coverH,color:PDFLib.rgb(0,0,0)});
        // Yeni fiyatı beyaz yaz
        page.drawText(newVal,{x,y,size:h.fontSizePdf,font:helv,color:PDFLib.rgb(1,1,1)});
      }
      const bytes=await pdf.save();
      const fd=new FormData(); fd.append('pdf', new File([new Blob([bytes],{type:'application/pdf'})], 'menu.pdf', {type:'application/pdf'}));
      const r=await fetch('/upload/'+slug,{method:'POST',body:fd,headers:{'X-Requested-With':'XMLHttpRequest'}});
      if(r.ok){ info.textContent='Kaydedildi. TV yenileniyor...'; setTimeout(()=>location.href='/panel/'+slug+'?ok=1',1000); }
      else { info.textContent='Yükleme hatası'; btn.disabled=false; }
    }catch(e){ console.error(e); info.textContent='Hata: '+(e?.message||'bilinmiyor'); btn.disabled=false; }
  };
  </script>`;
}
app.get("/panel-edit/:slug", needUserFor("slug"), async (req,res)=>{ await ensureTenantDirs(req.params.slug); res.set("Cache-Control","no-store"); res.send(editorHtml(req.params.slug)); });

/* ==================== HEALTH ==================== */
app.get("/health",(_req,res)=>res.json({ok:true,ts:Date.now()}));

/* ==================== PDF + UPLOAD ==================== */
const uploadSingle = multer({
  storage: multer.diskStorage({
    destination: async (req,_f,cb)=>{ const p=await ensureTenantDirs(req.params.slug); cb(null,p.tmpIn); },
    filename: (_req,file,cb)=>{ const base=(file.originalname||"file.pdf").replace(/[^\w.-]/g,""); cb(null,`menu.${Date.now()}.${Math.random().toString(16).slice(2)}.${base}.tmp`); }
  }),
  limits:{ fileSize:50*1024*1024 }
});
async function replaceFileAtomic(src,dst){
  await fsp.mkdir(path.dirname(dst),{recursive:true});
  try{ await fsp.rename(src,dst); }catch{ await fsp.copyFile(src,dst); await fsp.unlink(src).catch(()=>{}); }
}

app.get("/menu/:slug.pdf",async (req,res)=>{
  const p=tenantPaths(req.params.slug);
  fs.access(p.pdf, fs.constants.F_OK | fs.constants.R_OK, (err)=>{   // ← F_OK düzeltildi
    if(err) return res.status(404).send("menu.pdf not found");
    res.sendFile(p.pdf);
  });
});
app.post("/upload/:slug", needUserFor("slug"), uploadSingle.single("pdf"), async (req,res)=>{
  try{
    const p=tenantPaths(req.params.slug);
    if(!req.file) return res.status(400).send("Dosya alınamadı");
    await replaceFileAtomic(req.file.path,p.pdf);
    queueRender(p.safe);
    res.redirect(`/panel/${p.safe}?ok=1`);
  }catch(e){ console.error("[upload]",e); res.status(500).send("Yükleme hatası"); }
});

/* ==================== INBOX API ==================== */
const uploadMany = multer({
  storage: multer.diskStorage({
    destination: async (req,_f,cb)=>{ const p=await ensureTenantDirs(req.params.slug); cb(null,p.inbox); },
    filename: (_req,file,cb)=>{ const nm=sanitizeName(file.originalname||"dosya.pdf"); cb(null,nm); }
  }),
  limits:{ fileSize:50*1024*1024 }
});
async function listInbox(slug){
  const p=tenantPaths(slug);
  try{
    // Klasörün var olduğundan emin ol
    await fsp.mkdir(p.inbox, { recursive: true });
    
    // Her zaman fresh okuma için dosya sisteminden direkt oku
    const names = await fsp.readdir(p.inbox);
    const pdfNames = names.filter(n=>/\.pdf$/i.test(n));
    
    console.log('[listInbox]', slug, 'klasör:', p.inbox, 'bulunan dosyalar:', pdfNames.length);
    
    const stats = await Promise.all(pdfNames.map(async n=>{
      try {
        const fullPath = path.join(p.inbox, n);
        const stat = await fsp.stat(fullPath);
        return { name:n, size:stat.size, mtime:stat.mtimeMs };
      } catch(e) {
        console.error('[listInbox] stat hatası:', n, e);
        return null;
      }
    }));
    const valid = stats.filter(s => s !== null);
    valid.sort((a,b)=>b.mtime - a.mtime);
    
    console.log('[listInbox]', slug, 'dönen dosyalar:', valid.length);
    return valid;
  }catch(e){ 
    console.error('[listInbox] hata:', slug, e);
    return []; 
  }
}
app.get("/api/inbox/:slug", needUserFor("slug"), async (req,res)=>{ 
  // Cache'i tamamen devre dışı bırak
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Last-Modified': new Date().toUTCString(),
    'ETag': Date.now().toString()
  });
  
  const slug = tenantPaths(req.params.slug).safe;
  
  // Her zaman fresh okuma - dosya sistemini yeniden oku
  const files = await listInbox(slug);
  
  console.log('[api/inbox]', slug, '→', files.length, 'files', 'timestamp:', Date.now());
  
  res.json({ 
    files,
    timestamp: Date.now(),
    count: files.length
  }); 
});
app.get("/api/inbox/:slug/file/:name", needUserFor("slug"), async (req,res)=>{
  const p=tenantPaths(req.params.slug);
  const name=sanitizeName(req.params.name);
  const full=path.join(p.inbox,name);
  if (!full.startsWith(p.inbox)) return res.status(400).end();
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set('Cache-Control','no-store');                 // cache kapalı
  res.sendFile(full);
});
app.post("/api/inbox/:slug/upload", needUserFor("slug"), uploadMany.array("files", 20), async (_req,res)=>{ res.json({ok:true}); });
app.post("/api/inbox/:slug/activate", needUserFor("slug"), async (req,res)=>{
  const p=tenantPaths(req.params.slug);
  const name=sanitizeName(req.query.name||"");
  const src=path.join(p.inbox,name);
  if (!name || !fs.existsSync(src)) return res.status(404).json({ok:false});
  await replaceFileAtomic(src, p.pdf);
  queueRender(p.safe);
  res.json({ok:true});
});
app.delete("/api/inbox/:slug/delete", needUserFor("slug"), async (req,res)=>{
  const p=tenantPaths(req.params.slug);
  const name=sanitizeName(req.query.name||"");
  const full=path.join(p.inbox,name);
  if (!name || !fs.existsSync(full)) return res.status(404).json({ok:false});
  await fsp.unlink(full);
  res.json({ok:true});
});

/* ==================== TV / SSE ==================== */
const clientsBySlug=new Map(), lastUrlBySlug=new Map();
function send(res,data){ res.write(`data: ${data}\n\n`); }
function broadcastUrl(slug,url){ lastUrlBySlug.set(slug,url); const set=clientsBySlug.get(slug); if(!set) return; for(const r of set) send(r,JSON.stringify({url})); }
setInterval(()=>{ for(const set of clientsBySlug.values()) for(const r of set) r.write(":hb\n\n"); },25000);

app.get("/events/:slug",async (req,res)=>{
  const slug=tenantPaths(req.params.slug).safe;
  res.set({"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"});
  res.flushHeaders();
  const last=lastUrlBySlug.get(slug); if(last) send(res,JSON.stringify({url:last}));
  let set=clientsBySlug.get(slug); if(!set){ set=new Set(); clientsBySlug.set(slug,set); }
  set.add(res); req.on("close",()=>set.delete(res));
});

// TV sayfası (A/B buffered IMG)
function tvHtml(slug, firstA, firstB){
  const first = firstA?`/tenants/${slug}/menu_A.png`:(firstB?`/tenants/${slug}/menu_B.png`:"");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Menu Screen – ${slug}</title>
  <style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#stage{position:fixed;inset:0;background:#000}
  .layer{position:absolute;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000;transition:opacity .25s ease;filter:brightness(1.15) contrast(1.1);max-width:96vw;max-height:96vh;margin:auto}
  .hide{opacity:0}.show{opacity:1}</style>
  <div id="stage">${first?`<img id="imgA" class="layer show" src="${first}"><img id="imgB" class="layer hide" src="">`:``}</div>
  <script>
  const slug=${JSON.stringify(slug)}; let cur=document.getElementById('imgA'),nxt=document.getElementById('imgB');
  if(!cur){const s=document.getElementById('stage');cur=new Image();cur.className='layer show';nxt=new Image();nxt.className='layer hide';s.appendChild(cur);s.appendChild(nxt);}
  function base(u){try{return(u||'').split('?')[0];}catch{return u||'';}} function preload(u){return new Promise((ok,er)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=er;i.src=u;});}
  async function swapTo(u){if(!u)return;try{const i=await preload(u);nxt.src=i.src;nxt.className='layer show';cur.className='layer hide';const t=cur;cur=nxt;nxt=t;}catch{}}
  function goFull(){const el=document.documentElement;const r=el.requestFullscreen||el.webkitRequestFullscreen;try{if(r)r.call(el);}catch{}}
  document.addEventListener('click',goFull,{once:true});
  try{const es=new EventSource('/events/'+encodeURIComponent(slug)); es.onmessage=(ev)=>{try{const m=JSON.parse(ev.data||"{}");const cb=base(cur?.src),mb=base(m?.url); if(mb&&mb!==cb) swapTo(m.url);}catch{}};}catch{}
  </script>`;
}
app.get("/t/:slug", async (req,res)=>{
  const p=tenantPaths(req.params.slug); await ensureTenantDirs(p.safe);
  queueRender(p.safe); // TV açıldığında ilk PNG üret
  res.set("Cache-Control","no-store");
  res.send(tvHtml(p.safe, fs.existsSync(p.pngA), fs.existsSync(p.pngB)));
});

/* ==================== RENDER (PUPPETEER) ==================== */
app.get("/render/:slug", async (req,res)=>{
  const slug=tenantPaths(req.params.slug).safe;
  res.send(`<!doctype html><meta charset="utf-8"><title>Render ${slug}</title>
  <style>html,body{margin:0;padding:0;width:100vw;height:100vh;background:#000;overflow:hidden;cursor:none}
  #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000}canvas{width:100vw;height:100vh;object-fit:contain;display:block;background:#000}</style>
  <div id="wrap"><canvas id="c"></canvas></div>
  <script type="module">
  import { getDocument, GlobalWorkerOptions } from '/pdfjs/pdf.mjs'; GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.mjs';
  const c=document.getElementById('c'), ctx=c.getContext('2d');
  (async function(){ try{ const url='/menu/${slug}.pdf?v='+Date.now(); const pdf=await getDocument(url).promise; const pg=await pdf.getPage(1);
    let rot=(pg.rotate||0)%360; let vp=pg.getViewport({scale:1,rotation:rot}); if(vp.height>vp.width){ rot=(rot+90)%360; vp=pg.getViewport({scale:1,rotation:rot}); }
    const dpr=window.devicePixelRatio||1; const scale=Math.min((innerWidth*dpr)/vp.width,(innerHeight*dpr)/vp.height);
    const fvp=pg.getViewport({scale,rotation:rot}); c.width=Math.floor(fvp.width); c.height=Math.floor(fvp.height); await pg.render({canvasContext:ctx,viewport:fvp}).promise; }catch(e){console.error(e);} })();
  </script>`);
});

let browser;
async function ensureBrowser(){
  if (browser && browser.process && browser.process() && !browser.process().killed) return browser;
  browser = await puppeteer.launch({ headless:"new", executablePath: puppeteer.executablePath(), args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]});
  return browser;
}
const pendingBySlug=new Map(), currentAB=new Map();
async function renderPNG(slug){
  const p=tenantPaths(slug);
  if(!fs.existsSync(p.pdf)) return;
  await ensureTenantDirs(slug);
  try{
    const b=await ensureBrowser(); const page=await b.newPage();
    await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
    await page.goto(`http://localhost:${PORT}/render/${encodeURIComponent(p.safe)}`,{waitUntil:"networkidle2"});
    await page.waitForFunction(()=>!!document.querySelector("canvas"),{timeout:6000}).catch(()=>{});
    await new Promise(r=>setTimeout(r,650));
    const cur=currentAB.get(slug)||"A"; const target=(cur==="A")?p.pngB:p.pngA; const tmp=target+".tmp";
    await page.screenshot({path:tmp}); await fsp.rename(tmp,target); await page.close();
    const nextCur=(cur==="A")?"B":"A"; currentAB.set(slug,nextCur);
    const url=`/tenants/${p.safe}/menu_${nextCur}.png?v=${Date.now()}`; broadcastUrl(p.safe,url); console.log("[render]",p.safe,"→",url);
  }catch(e){ console.error("[render]",p.safe,e); }
}
function queueRender(slug){
  if(pendingBySlug.get(slug)) return;
  pendingBySlug.set(slug,true);
  setTimeout(async()=>{ try{ await renderPNG(slug); } finally{ pendingBySlug.set(slug,false); } },150);
}
app.post("/refresh/:slug",async (req,res)=>{
  const p=tenantPaths(req.params.slug);
  const cur=currentAB.get(p.safe)||(fs.existsSync(p.pngA)?"A":"B");
  const url=`/tenants/${p.safe}/menu_${cur}.png?v=${Date.now()}`;
  broadcastUrl(p.safe,url);
  res.json({ok:true});
});
app.post("/rerender/:slug",async (req,res)=>{ queueRender(req.params.slug); res.json({ok:true}); });

/* ==================== START ==================== */
const server=app.listen(PORT,"0.0.0.0", async ()=>{
  console.log(`✅ Server up → http://localhost:${PORT}`);
  const db=await loadDB(); for(const u of db.users) await ensureTenantDirs(u.slug);
});
async function cleanup(){ try{ await browser?.close(); }catch{} server.close(()=>process.exit(0)); }
process.on("SIGINT",cleanup); process.on("SIGTERM",cleanup);
