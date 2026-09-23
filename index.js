/**
 * سازینو — بک‌اند سازکوین برای saztik.com
 * Node 18+ · فقط یک وابستگی: express  (npm i express)
 *
 * اجرا:  BOT_TOKEN=123:ABC PORT=8787 node server/index.js
 * آدرس:  https://saztik.com/api/sazino  (با Nginx به این پورت پروکسی کن)
 *
 * قوانین (همه سمت سرور اجرا می‌شود، مرورگر قابل اعتماد نیست):
 *  - هویت = آیدی تلگرام، از initData امضاشده با HMAC توکن بات.
 *  - هدیهٔ ۱۰۰ سازکوین فقط یک بار به هر آیدی (bonus).
 *  - bonus قابل برداشت نیست؛ شرط اول از bonus کم می‌شود، بعد از cash.
 *  - سود بردها به cash می‌رود؛ فقط cash قابل برداشت است.
 *  - نتیجهٔ هر دور را خود سرور با crypto تولید می‌کند (نه کلاینت).
 */
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { initTreasury, treasuryReady, sendSaz, scanDeposits, treasuryAddress, treasuryTonBalance } from "./ton.js";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PORT = Number(process.env.PORT || 8787);
const DB_FILE = process.env.DB_FILE || path.resolve("sazino-db.json");
const GIFT = 100;
const MIN_WITHDRAW = 50;
const MAX_AGE_SEC = 24 * 3600;
const DEV_ALLOW_GUEST = process.env.DEV_ALLOW_GUEST === "1"; // فقط برای تست محلی

// ---------- storage (JSON file; برای تولید جدی به SQLite/Postgres ببرید) ----------
const AUTO_PAYOUT_MAX = Number(process.env.AUTO_PAYOUT_MAX || 500); // بالاتر از این → بررسی دستی
let db = { users: {}, rounds: {}, withdrawals: [], deposits: {}, tableResults: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  db = { users: {}, rounds: {}, withdrawals: [], deposits: {}, tableResults: {}, ...loaded };
} catch {
  /* fresh */
}
let saveTimer = null;
/** Atomic-ish persist: write temp then rename so concurrent readers never see a half-written file.
 *  Still single-process; for multi-instance use SQLite/Postgres. */
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DB_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error("[db] persist failed", e);
    }
  }, 150);
};

// ---------- roulette rules (mirror of client) ----------
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
function mult(kind) {
  if (kind === "straight") return 35;
  if (/^(dozen|col)[123]$/.test(kind)) return 2;
  return 1;
}
function wins(key, r) {
  r = Number(r);
  if (key.startsWith("straight:")) return Number(key.split(":")[1]) === r;
  if (r === 0) return false; // zero only wins straight:0
  switch (key) {
    case "red": return RED.has(r);
    case "black": return !RED.has(r);
    case "odd": return r % 2 === 1;
    case "even": return r % 2 === 0;
    case "low": return r >= 1 && r <= 18;
    case "high": return r >= 19 && r <= 36;
    case "dozen1": return r >= 1 && r <= 12;
    case "dozen2": return r >= 13 && r <= 24;
    case "dozen3": return r >= 25 && r <= 36;
    case "col1": return r % 3 === 1;
    case "col2": return r % 3 === 2;
    case "col3": return r % 3 === 0;
    default: return false;
  }
}
// straight:0..36 explicitly (fixes any ambiguity around 26, 30-36, etc.)
const VALID_KEY = /^(straight:(0|[1-9]|[1-2][0-9]|3[0-6])|red|black|odd|even|low|high|dozen[123]|col[123])$/;

// ---------- Telegram initData verification ----------
function verifyInitData(raw) {
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;
  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const raw = h.startsWith("tma ") ? h.slice(4) : "";
  const user = verifyInitData(raw);
  if (user?.id) {
    req.uid = `tg:${user.id}`;
    req.tgName = user.first_name || "";
    return next();
  }
  if (DEV_ALLOW_GUEST && req.headers["x-dev-uid"]) {
    req.uid = String(req.headers["x-dev-uid"]);
    return next();
  }
  return res.status(401).json({ error: "ورود نامعتبر — فقط از داخل تلگرام" });
}

function getUser(uid) {
  return (db.users[uid] ||= {
    uid,
    name: "",
    bonus: 0,
    cash: 0,
    giftClaimed: false,
    peak: 0,
    biggestWin: 0,
    spins: 0,
    totalWithdrawn: 0,
    createdAt: Date.now(),
  });
}
const walletOf = (u) => ({ bonus: u.bonus, cash: u.cash });
const statsOf = (u) => ({ peak: u.peak, biggestWin: u.biggestWin, spins: u.spins, totalWithdrawn: u.totalWithdrawn });

// ---------- shared table: one global round every 30s, one result for everyone ----------
const BET_WINDOW_MS = 20000, SPIN_MS = 6000, RESULT_MS = 4000;
const ROUND_MS = BET_WINDOW_MS + SPIN_MS + RESULT_MS;
db.tableResults ||= {}; // roundId -> result
const roundIdNow = (t = Date.now()) => Math.floor(t / ROUND_MS);
const roundPhase = (roundId, t = Date.now()) => {
  const el = t - roundId * ROUND_MS;
  if (el < 0) return "future";
  if (el < BET_WINDOW_MS) return "betting";
  if (el < BET_WINDOW_MS + SPIN_MS) return "spinning";
  if (el < ROUND_MS) return "result";
  return "past";
};
/** نتیجهٔ یک دور: اولین بار که خواسته شود (بعد از بسته‌شدن شرط‌ها) ساخته و ثابت می‌شود. */
function resultOf(roundId) {
  const ph = roundPhase(roundId);
  if (ph === "betting" || ph === "future") return null;
  if (db.tableResults[roundId] === undefined) {
    // 0..36 inclusive (European roulette including zero)
    db.tableResults[roundId] = crypto.randomInt(0, 37);
    // پاکسازی نتایج قدیمی
    for (const k of Object.keys(db.tableResults)) if (Number(k) < roundId - 200) delete db.tableResults[k];
    persist();
  }
  return Number(db.tableResults[roundId]);
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Dev-Uid");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// ساعت میز + نتایج ۲۰ دور اخیر (برای هم‌گام‌سازی همهٔ کلاینت‌ها)
app.get("/table", (_req, res) => {
  const now = Date.now();
  const cur = roundIdNow(now);
  const results = {};
  for (let id = cur - 20; id <= cur; id++) {
    const r = resultOf(id);
    if (r !== null) results[id] = r;
  }
  res.json({ now, roundMs: ROUND_MS, betWindowMs: BET_WINDOW_MS, spinMs: SPIN_MS, resultMs: RESULT_MS, results });
});
app.get("/table/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  res.json({ roundId: id, result: resultOf(id), now: Date.now() });
});

// ورود + هدیهٔ یک‌باره
app.post("/auth", auth, (req, res) => {
  const u = getUser(req.uid);
  if (req.tgName) u.name = req.tgName;
  let giftGranted = false;
  if (!u.giftClaimed) {
    u.giftClaimed = true;
    u.bonus += GIFT;
    u.peak = Math.max(u.peak, u.bonus + u.cash);
    giftGranted = true;
  }
  persist();
  res.json({ wallet: walletOf(u), giftGranted, stats: statsOf(u) });
});

app.get("/wallet", auth, (req, res) => res.json({ wallet: walletOf(getUser(req.uid)) }));

// ثبت شرط‌های یک دور — bonus اول، بعد cash
app.post("/round/open", auth, (req, res) => {
  const { roundId, bets } = req.body || {};
  if (!roundId || typeof bets !== "object" || !bets) return res.status(400).json({ error: "درخواست نامعتبر" });
  const u = getUser(req.uid);
  const rid = Number(roundId);
  if (!Number.isFinite(rid)) return res.status(400).json({ error: "شمارهٔ دور نامعتبر" });
  // شرط فقط تا لحظهٔ بسته‌شدن همان دورِ مشترک پذیرفته می‌شود (۲.۵ ثانیه مهلت برای تأخیر شبکه زیر بار)
  const ph = roundPhase(rid, Date.now() - 2500);
  if (ph !== "betting") return res.status(409).json({ error: "شرط‌های این دور بسته شده" });
  if (db.rounds[`${u.uid}:${roundId}`]) return res.status(409).json({ error: "این دور قبلاً ثبت شده" });

  let total = 0;
  const clean = {};
  for (const [k, v] of Object.entries(bets)) {
    const amt = Math.floor(Number(v));
    if (!VALID_KEY.test(k) || !(amt > 0)) return res.status(400).json({ error: `شرط نامعتبر: ${k}` });
    clean[k] = amt;
    total += amt;
  }
  if (total === 0) return res.status(400).json({ error: "شرطی وجود ندارد" });
  if (total > u.bonus + u.cash) return res.status(402).json({ error: "موجودی کافی نیست" });

  // funding per bet: bonus first
  let bonusLeft = u.bonus;
  const fund = {};
  for (const [k, amt] of Object.entries(clean)) {
    const b = Math.min(bonusLeft, amt);
    bonusLeft -= b;
    fund[k] = { bonus: b, cash: amt - b };
  }
  const fromBonus = u.bonus - bonusLeft;
  u.bonus = bonusLeft;
  u.cash -= total - fromBonus;

  // نتیجه به این کاربر تعلق ندارد؛ نتیجهٔ مشترکِ دور بعد از بسته‌شدن شرط‌ها ساخته می‌شود
  db.rounds[`${u.uid}:${roundId}`] = { roundId: rid, bets: clean, fund, settled: false, at: Date.now() };
  persist();
  res.json({ wallet: walletOf(u) });
});

// تسویهٔ دور — سود به cash، اصل شرط به منبع خودش برمی‌گردد
app.post("/round/close", auth, (req, res) => {
  const { roundId } = req.body || {};
  const u = getUser(req.uid);
  const r = db.rounds[`${u.uid}:${roundId}`];
  if (!r) return res.status(404).json({ error: "دور پیدا نشد" });
  const result = resultOf(r.roundId ?? Number(roundId));
  if (result === null) return res.status(425).json({ error: "این دور هنوز بسته نشده" });
  if (r.settled) return res.json({ wallet: walletOf(u), won: r.won, result });
  r.result = result;

  let backBonus = 0, backCash = 0, profit = 0, totalReturn = 0;
  for (const [k, amt] of Object.entries(r.bets)) {
    if (!wins(k, result)) continue;
    backBonus += r.fund[k].bonus;
    backCash += r.fund[k].cash;
    profit += amt * mult(k.startsWith("straight:") ? "straight" : k);
    totalReturn += amt * (mult(k.startsWith("straight:") ? "straight" : k) + 1);
  }
  u.bonus += backBonus;
  u.cash += backCash + profit;
  u.spins += 1;
  u.peak = Math.max(u.peak, u.bonus + u.cash);
  u.biggestWin = Math.max(u.biggestWin, totalReturn);
  r.settled = true;
  r.won = totalReturn;
  persist();
  res.json({ wallet: walletOf(u), won: totalReturn, result });
});

// تسویهٔ خودکار دورهایی که کاربر (مثلاً به‌خاطر قطع اینترنت) close نکرده — هر ۱۵ ثانیه
// برای ده‌ها کاربر همزمان: فقط دورهای گذشته، یک‌بار، با uid دقیق از کلید tg:<id>:<roundId>
setInterval(() => {
  const cur = roundIdNow();
  let changed = false;
  for (const [key, r] of Object.entries(db.rounds)) {
    if (r.settled || r.roundId === undefined || r.roundId >= cur) continue;
    const result = resultOf(r.roundId);
    if (result === null) continue;
    // key = "tg:123456:789" → uid = "tg:123456" (همهٔ بخش‌ها به‌جز آخرین که roundId است)
    const parts = key.split(":");
    const uid = parts.length >= 3 ? parts.slice(0, -1).join(":") : key;
    const u = getUser(uid);
    let backBonus = 0, backCash = 0, profit = 0, totalReturn = 0;
    for (const [k, amt] of Object.entries(r.bets || {})) {
      if (!wins(k, result)) continue;
      const f = r.fund?.[k] || { bonus: 0, cash: 0 };
      backBonus += f.bonus;
      backCash += f.cash;
      const m = mult(k.startsWith("straight:") ? "straight" : k);
      profit += amt * m;
      totalReturn += amt * (m + 1);
    }
    u.bonus += backBonus;
    u.cash += backCash + profit;
    u.spins += 1;
    u.peak = Math.max(u.peak, u.bonus + u.cash);
    u.biggestWin = Math.max(u.biggestWin, totalReturn);
    r.settled = true;
    r.won = totalReturn;
    r.result = result;
    changed = true;
  }
  // پاکسازی دورهای تسویه‌شدهٔ خیلی قدیمی (جلوگیری از رشد بی‌نهایت فایل تحت بار)
  const pruneBefore = cur - 50;
  for (const key of Object.keys(db.rounds)) {
    const r = db.rounds[key];
    if (r.settled && r.roundId !== undefined && r.roundId < pruneBefore) {
      delete db.rounds[key];
      changed = true;
    }
  }
  if (changed) persist();
}, 15000);

// ثبت پروفایل (کیف پول TON / شماره) — یک بار در اولین برداشت
app.post("/profile", auth, (req, res) => {
  const u = getUser(req.uid);
  const { tonAddress, phone } = req.body || {};
  if (tonAddress) u.tonAddress = String(tonAddress).slice(0, 80);
  if (phone) u.phone = String(phone).slice(0, 20);
  persist();
  res.json({ ok: true });
});

// برداشت — فقط از cash → ارسال SAZ روی TON به کیف پول کاربر
app.post("/withdraw", auth, async (req, res) => {
  const amount = Math.floor(Number(req.body?.amount));
  const address = String(req.body?.address || "").slice(0, 80);
  const u = getUser(req.uid);
  if (!(amount >= MIN_WITHDRAW)) return res.status(400).json({ error: `حداقل برداشت ${MIN_WITHDRAW} SAZ است` });
  if (amount > u.cash) return res.status(402).json({ error: "بیشتر از موجودی قابل برداشت" });
  if (!address) return res.status(400).json({ error: "کیف پول TON وصل نیست" });
  // یک برداشت در حال انجام برای هر کاربر
  if (db.withdrawals.some((w) => w.uid === u.uid && w.status === "processing")) return res.status(429).json({ error: "برداشت قبلی هنوز در حال انجام است" });

  u.cash -= amount;
  u.tonAddress = address;
  const txId = crypto.randomBytes(4).toString("hex").toUpperCase();
  const rec = { txId, uid: u.uid, name: u.name, amount, address, status: "processing", at: Date.now() };
  db.withdrawals.push(rec);
  persist();

  const manual = !treasuryReady() || amount > AUTO_PAYOUT_MAX;
  if (manual) {
    rec.status = "pending"; // ادمین دستی می‌فرستد و بعد status را sent می‌کند
    u.totalWithdrawn += amount;
    persist();
    return res.json({ wallet: walletOf(u), txId, status: "pending" });
  }
  try {
    rec.onchain = await sendSaz(address, amount, `Sazino payout ${txId}`);
    rec.status = "sent";
    u.totalWithdrawn += amount;
    persist();
    res.json({ wallet: walletOf(u), txId, status: "sent" });
  } catch (e) {
    // برگشت پول به کاربر
    u.cash += amount;
    rec.status = "failed";
    rec.error = String(e.message || e);
    persist();
    console.error("[withdraw] failed", e);
    res.status(502).json({ error: "ارسال روی شبکه ناموفق بود؛ مبلغ به حسابت برگشت" });
  }
});

// بررسی واریز: کاربر SAZ را با کامنت tg:<id> به خزانه فرستاده
app.post("/deposit/check", auth, async (req, res) => {
  const u = getUser(req.uid);
  if (!treasuryReady()) return res.status(503).json({ error: "سرویس واریز فعال نیست" });
  let credited = 0;
  try {
    const found = await scanDeposits(60);
    for (const d of found) {
      if (db.deposits[d.txHash]) continue; // قبلاً اعمال شده
      const target = getUser(d.uid);
      target.cash += d.amount;
      target.peak = Math.max(target.peak, target.bonus + target.cash);
      db.deposits[d.txHash] = { uid: d.uid, amount: d.amount, at: Date.now() };
      if (d.uid === u.uid) credited += d.amount;
    }
    persist();
    res.json({ wallet: walletOf(u), credited });
  } catch (e) {
    console.error("[deposit] scan failed", e);
    res.status(502).json({ error: "خواندن شبکه ناموفق بود" });
  }
});

app.get("/treasury", async (_req, res) => {
  res.json({ ready: treasuryReady(), address: treasuryAddress(), ton: treasuryReady() ? await treasuryTonBalance() : 0 });
});

// شارژ از سازتیک (سرور به سرور؛ با کلید مخفی، نه از مرورگر)
app.post("/admin/topup", (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(403).json({ error: "forbidden" });
  const { uid, amount } = req.body || {};
  const u = getUser(String(uid));
  u.cash += Math.floor(Number(amount) || 0);
  persist();
  res.json({ wallet: walletOf(u) });
});

app.get("/admin/withdrawals", (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(403).json({ error: "forbidden" });
  res.json(db.withdrawals);
});

initTreasury()
  .catch((e) => console.error("[ton] init failed", e))
  .finally(() => app.listen(PORT, () => console.log(`Sazino API on :${PORT}  (bot token ${BOT_TOKEN ? "set" : "MISSING"}, treasury ${treasuryReady() ? "ready" : "manual mode"})`)));
