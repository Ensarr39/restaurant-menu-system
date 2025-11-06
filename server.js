// server.js  —  A/B double-buffer + beyaz ekran kilidi + rotasyon + akıllı root yönlendirme
// Kurulum (bir kere):  npm i express multer chokidar pdfjs-dist puppeteer

const express   = require("express");
const path      = require("path");
const fs        = require("fs");
const fsp       = fs.promises;
const multer    = require("multer");
const chokidar  = require("chokidar");
const puppeteer = require("puppeteer");
const { exec }  = require("child_process");

const app  = express();
const PORT = process.env.PORT || 3000;

const ROOT    = __dirname;
const PUBLIC  = path.join(ROOT, "public");
const STORAGE = path.join(ROOT, "storage");
const TMPDIR  = path.join(STORAGE, "__incoming");
const FILE    = path.join(STORAGE, "menu.pdf");

// A/B hedefleri (sahne arkası değişir, ekranda asla boş kalmaz)
const PNG_A = path.join(PUBLIC, "menu_A.png");
const PNG_B = path.join(PUBLIC, "menu_B.png");

// Log & crash guard
process.on("uncaughtException", e => console.error("[uncaught]", e));
process.on("unhandledRejection", e => console.error("[unhandled]", e));

for (const p of [PUBLIC, STORAGE, TMPDIR]) if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });

/* ---------- pdf.js (mjs MIME fix) ---------- */
const pdfjsDistPath = path.dirname(require.resolve("pdfjs-dist/package.json"));
app.use("/pdfjs", express.static(path.join(pdfjsDistPath, "build"), {
  setHeaders: (res, fp) => {
    if (fp.endsWith(".mjs")) res.type("text/javascript");
    res.setHeader("Cache-Control", "no-store");
  },
}));

/* ---------- Genel ---------- */
app.disable("etag");
app.use((_, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use("/public", express.static(PUBLIC, { etag: false }));
app.use(express.static(PUBLIC, { etag: false }));

/* ---------- Sağlık ---------- */
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------- Panel ---------- */
app.get("/panel", (_req, res) => res.sendFile(path.join(PUBLIC, "panel.html")));

/* ---------- PDF servis ---------- */
app.get("/menu.pdf", (_req, res) => {
  fs.access(FILE, fs.constants.F_Ok | fs.constants.R_OK, (err) => {
    if (err) return res.status(404).send("menu.pdf not found");
    res.sendFile(FILE);
  });
});

/* ---------- Upload ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => cb(null, TMPDIR),
    filename: (_req, file, cb) => {
      const base = (file.originalname || "file.pdf").replace(/[^\w.-]/g, "_");
      cb(null, `menu.${Date.now()}.${Math.random().toString(16).slice(2)}.${base}.tmp`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

async function replaceFileAtomic(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try { await fsp.rename(src, dst); }
  catch { await fsp.copyFile(src, dst); await fsp.unlink(src).catch(()=>{}); }
}

app.post("/upload", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("Dosya alınamadı");
    await replaceFileAtomic(req.file.path, FILE);
    console.log("[upload] menu.pdf güncellendi");
    queueRender();                           // yeni PNG üret (A/B)
    res.redirect("/panel?ok=1");
  } catch (e) {
    console.error("[upload] hata:", e);
    res.status(500).send("Yükleme hatası");
  }
});

/* ---------- Windows: Adobe’de aç ---------- */
function openWithAdobe(file) {
  const cands = [
    'C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
    'C:\\Program Files (x86)\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
    'C:\\Program Files\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe',
    'C:\\Program Files (x86)\\Adobe\\Acrobat Reader DC\\Reader\\AcroRd32.exe',
  ];
  const exe = cands.find(p => fs.existsSync(p));
  const cmd = exe ? `"${exe}" "${file}"` : `start "" "${file}"`;
  return new Promise((resolve, reject) => exec(cmd, (e) => e ? reject(e) : resolve()));
}
app.get("/open", async (_req, res) => {
  if (!fs.existsSync(FILE)) return res.status(404).send("PDF bulunamadı");
  try { await openWithAdobe(FILE); res.send("OK"); } catch { res.status(500).send("PDF açılamadı"); }
});

/* ---------- SSE (yalnızca yeni URL gönderir + heartbeat) ---------- */
const clients = new Set();
let lastUrl = fs.existsSync(PNG_A) ? "/menu_A.png" : (fs.existsSync(PNG_B) ? "/menu_B.png" : "");

function send(res, data) { res.write(`data: ${data}\n\n`); }
function broadcastUrl(url) {
  lastUrl = url;
  for (const r of clients) send(r, JSON.stringify({ url }));
}
setInterval(() => {                 // Cloudflare/TV timeouts’a karşı kalp atışı
  for (const r of clients) r.write(":hb\n\n");
}, 25000);

app.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  res.flushHeaders();
  if (lastUrl) send(res, JSON.stringify({ url: lastUrl + `?t=${Date.now()}` }));
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

/* ---------- PDF → PNG (A/B double-buffer) ---------- */
let browser, pending = false, current = "A"; // A ekranda → B’ye yazar, sonra tersine döneriz

async function ensureBrowser() {
  if (browser && browser.process && browser.process() && !browser.process().killed) return browser;
  browser = await puppeteer.launch({
    headless: "new",
    executablePath: puppeteer.executablePath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  return browser;
}

async function renderPNG() {
  if (!fs.existsSync(FILE)) return;
  try {
    const b = await ensureBrowser();
    const page = await b.newPage();

    // 16:9 – arka planı siyah tut (flash'a karşı)
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${PORT}/?fs=0`, { waitUntil: "networkidle2" });
    await page.addStyleTag({ content: "html,body{background:#000!important}" });
    await page.waitForFunction(() => !!document.querySelector("canvas,embed,iframe,img"), { timeout: 6000 }).catch(()=>{});
    await new Promise(r => setTimeout(r, 650)); // çizimin oturması için

    // ekranda OLMAYAN hedefe yaz
    const target = (current === "A") ? PNG_B : PNG_A;
    const tmp = target + ".tmp";
    await page.screenshot({ path: tmp });      // önce tmp
    await fsp.rename(tmp, target);             // atomik yer değiştirme
    await page.close();

    // aktif yüzü değiştir ve ekrana yeni URL’i ver
    current = (current === "A") ? "B" : "A";
    const url = (current === "A" ? "/menu_A.png" : "/menu_B.png") + `?v=${Date.now()}`;
    console.log("[render] hazır:", url);
    broadcastUrl(url);
  } catch (e) {
    console.error("[render] PNG hatası:", e);
  }
}

function queueRender() {
  if (pending) return;
  pending = true;
  setTimeout(async () => { try { await renderPNG(); } finally { pending = false; } }, 150);
}

/* ---------- Depoyu izle ---------- */
chokidar.watch(STORAGE, { ignoreInitial: true, depth: 0 })
  .on("add",    p => { if (path.basename(p) === "menu.pdf") { console.log("[watch] add");    queueRender(); } })
  .on("change", p => { if (path.basename(p) === "menu.pdf") { console.log("[watch] change"); queueRender(); } })
  .on("unlink", p => { if (path.basename(p) === "menu.pdf") { console.log("[watch] unlink"); } });

/* ---------- TV ekranı (çift layer + preload, periyodik refresh YOK) ---------- */
app.get("/screen", (req, res) => {
  const first = fs.existsSync(PNG_A) ? "/menu_A.png" : (fs.existsSync(PNG_B) ? "/menu_B.png" : "");
  const rot = [0,90,180,270].includes(Number(req.query.rot)) ? Number(req.query.rot) : 0; // isteğe bağlı döndürme

  res.set("Cache-Control", "no-store");
  res.send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Screen IMG - menu</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}
  #stage{position:fixed;inset:0;background:#000}
  .layer{
    position:absolute;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000;
    transition:opacity .25s ease; image-orientation:none;
    transform: rotate(${rot}deg); transform-origin:center center;
  }
  .hide{opacity:0} .show{opacity:1}
</style></head><body>
  <div id="stage">
    ${first
      ? `<img id="imgA" class="layer show" src="${first}">
         <img id="imgB" class="layer hide" src="">`
      : `<div style="color:#bbb;display:flex;align-items:center;justify-content:center;inset:0;position:absolute">PNG hazırlanıyor...</div>`}
  </div>
<script>
  let cur = document.getElementById('imgA');
  let nxt = document.getElementById('imgB');
  if(!cur){
    const s=document.getElementById('stage');
    cur=new Image();cur.className='layer show';
    nxt=new Image();nxt.className='layer hide';
    s.appendChild(cur); s.appendChild(nxt);
  }

  async function preload(url){
    return new Promise((resolve,reject)=>{
      const im = new Image();
      im.onload  = ()=>resolve(im);
      im.onerror = reject;
      im.src = url;
    });
  }
  async function swapTo(url){
    if(!url) return;
    try{
      const im = await preload(url);
      if (!im || !im.src) return;
      nxt.src = im.src;
      nxt.className='layer show';
      cur.className='layer hide';
      const t = cur; cur = nxt; nxt = t;
    }catch{}
  }

  try{
    const es = new EventSource('/events');
    es.onmessage = (ev)=>{ try{
      const msg = JSON.parse(ev.data||"{}");
      if(msg.url && msg.url !== cur?.src) swapTo(msg.url);
    }catch{} };
  }catch{}

  (async()=>{ try{ if(!document.fullscreenElement) await document.documentElement.requestFullscreen(); }catch{} })();
</script></body></html>`);
});

/* ---------- Akıllı ROOT yönlendirme ----------
   - Normal kullanıcı:   "/"  →  /screen
   - Puppeteer / local:  "/"  →  index.html (pdf.js viewer; render için) */
app.get("/", (req, res) => {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const isHeadless = ua.includes("headlesschrome") || ua.includes("puppeteer");
  const isLocal = req.hostname === "localhost" || req.hostname === "127.0.0.1";
  if (isHeadless || isLocal) {
    return res.sendFile(path.join(PUBLIC, "index.html"));
  }
  return res.redirect(302, "/screen");
});

/* ---------- Sunucu ---------- */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server up → http://localhost:${PORT}  (panel: /panel  tv: /screen)`);
  queueRender(); // açılışta üret
});

/* ---------- Temiz kapatma ---------- */
async function cleanup(){ try{ await browser?.close(); }catch{} server.close(()=>process.exit(0)); }
process.on("SIGINT",  cleanup);
process.on("SIGTERM", cleanup);
