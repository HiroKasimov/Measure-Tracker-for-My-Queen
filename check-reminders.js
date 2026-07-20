/**
 * Cycle Tracker — Reminder Checker (GitHub Actions version)
 * -------------------------------------------------------------
 * Bu skript Cloud Function EMAS — oddiy Node.js skripti. GitHub Actions
 * uni har 15 daqiqada ishga tushiradi (bepul, chunki repo public).
 *
 * Ikkala kanalga ham xabar yuboradi (ikkalasi ham sozlangan bo'lsa):
 * 1) Telegram bot orqali xabar
 * 2) Firebase Cloud Messaging orqali brauzer push
 *
 * "Oxirgi marta qachon yuborilgani" alohida "cycleTrackerMeta/lastNotified"
 * tugunida saqlanadi — bunga faqat shu skript (service account orqali)
 * tega oladi, asosiy ilova bu joyga umuman tegmaydi.
 */

const admin = require('firebase-admin');

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;

if (!serviceAccountJson) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON environment variable topilmadi. GitHub Secret to\'g\'ri qo\'yilganini tekshiring.');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN topilmadi — Telegram xabarlari o\'tkazib yuboriladi, faqat brauzer push (agar sozlangan bo\'lsa) ishlaydi.');
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON JSON sifatida o\'qilmadi:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://shokh-s-project-default-rtdb.firebaseio.com'
});
const db = admin.database();

/* ============================================================
   DATE HELPERS (index.html dagi bilan bir xil mantiq)
============================================================ */
function fmt(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseDate(s) {
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, m - 1, day);
}
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// Uzbekiston doim UTC+5 (DST yo'q)
function tashkentNow() {
  return new Date(Date.now() + 5 * 3600 * 1000);
}

/* ============================================================
   CYCLE MATH (client bilan bir xil)
============================================================ */
function getPeriodRanges(periodDays) {
  const days = [...(periodDays || [])].sort();
  const ranges = [];
  let cur = null;
  for (const d of days) {
    if (cur && daysBetween(parseDate(cur.end), parseDate(d)) === 1) { cur.end = d; }
    else { if (cur) ranges.push(cur); cur = { start: d, end: d }; }
  }
  if (cur) ranges.push(cur);
  return ranges;
}
function isPeriodDay(periodDays, ds) { return (periodDays || []).includes(ds); }

function cycleInfoForDate(data, dateStr) {
  const ranges = getPeriodRanges(data.periodDays);
  const d = parseDate(dateStr);
  const settings = data.settings || { cycleLength: 28, periodLength: 5 };
  if (!ranges.length) {
    return { dayInCycle: 1, cycleLength: settings.cycleLength, periodLength: settings.periodLength };
  }
  let idx = -1;
  for (let i = 0; i < ranges.length; i++) { if (parseDate(ranges[i].start) <= d) idx = i; }
  if (idx === -1) {
    const first = ranges[0];
    const cl = settings.cycleLength;
    const diff = daysBetween(d, parseDate(first.start));
    const cyclesBack = Math.max(1, Math.ceil(diff / cl));
    const projectedStart = addDays(parseDate(first.start), -cyclesBack * cl);
    let dayInCycle = daysBetween(projectedStart, d) + 1;
    dayInCycle = ((dayInCycle - 1) % cl + cl) % cl + 1;
    return { dayInCycle, cycleLength: cl, periodLength: settings.periodLength };
  }
  const cur = ranges[idx];
  const curStart = parseDate(cur.start);
  const periodLen = daysBetween(curStart, parseDate(cur.end)) + 1;
  const next = ranges[idx + 1];
  let cycleLen = next ? daysBetween(curStart, parseDate(next.start)) : settings.cycleLength;
  if (cycleLen < periodLen) cycleLen = Math.max(periodLen + 1, settings.cycleLength);
  let dayInCycle = daysBetween(curStart, d) + 1;
  if (dayInCycle > cycleLen) dayInCycle = ((dayInCycle - 1) % cycleLen) + 1;
  return { dayInCycle, cycleLength: cycleLen, periodLength: periodLen };
}

function avgCycleLength(data) {
  const ranges = getPeriodRanges(data.periodDays);
  const settings = data.settings || { cycleLength: 28 };
  if (ranges.length < 2) return settings.cycleLength;
  const gaps = [];
  for (let i = 1; i < ranges.length; i++) gaps.push(daysBetween(parseDate(ranges[i - 1].start), parseDate(ranges[i].start)));
  const last6 = gaps.slice(-6);
  return Math.round(last6.reduce((a, b) => a + b, 0) / last6.length);
}
function nextPeriodDate(data, today) {
  const ranges = getPeriodRanges(data.periodDays);
  const settings = data.settings || { cycleLength: 28 };
  if (!ranges.length) return addDays(today, settings.cycleLength);
  const last = ranges[ranges.length - 1];
  const cl = avgCycleLength(data);
  let next = addDays(parseDate(last.start), cl);
  let guard = 0;
  while (next < today && guard < 80) { next = addDays(next, cl); guard++; }
  return next;
}
function predictedOvulationDate(data, todayStr, today) {
  const ctx = cycleInfoForDate(data, todayStr);
  const ll = (data.settings || {}).lutealLength || 14;
  const ovDay = Math.max(ctx.periodLength + 1, ctx.cycleLength - ll);
  const cycleStart = addDays(today, -(ctx.dayInCycle - 1));
  return addDays(cycleStart, ovDay - 1);
}

/* ============================================================
   NOTIFICATION SENDERS (Telegram + Firebase Cloud Messaging)
============================================================ */
async function sendTelegram(chatId, title, body) {
  if (!chatId || !TELEGRAM_BOT_TOKEN) return false;
  const text = `${title}\n${body}\n\n🔗 https://hirokasimov.github.io/Measure-Tracker-for-My-Queen/`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const json = await res.json();
    if (!json.ok) {
      console.error('❌ Telegram xato:', json.description);
      return false;
    }
    console.log(`✓ Telegram'ga yuborildi: ${title}`);
    return true;
  } catch (e) {
    console.error('❌ Telegram so\'rov xatosi:', e.message);
    return false;
  }
}

async function sendFcm(token, title, body) {
  if (!token) return false;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      webpush: {
        fcmOptions: { link: 'https://hirokasimov.github.io/Measure-Tracker-for-My-Queen/' }
      }
    });
    console.log(`✓ Brauzer push yuborildi: ${title}`);
    return true;
  } catch (e) {
    console.error('❌ FCM xato:', e.message);
    return false;
  }
}

// Ikkalasiga ham urinadi (borlariga). Kamida bittasi muvaffaqiyatli bo'lsa true qaytaradi.
async function sendBoth(data, title, body) {
  const results = await Promise.all([
    sendTelegram(data.telegramChatId, title, body),
    sendFcm(data.fcmToken, title, body)
  ]);
  return results.some(Boolean);
}

/* ============================================================
   MAIN
============================================================ */
async function main() {
  const dataSnap = await db.ref('cycleTracker').once('value');
  const data = dataSnap.val();
  if (!data || (!data.telegramChatId && !data.fcmToken)) {
    console.log("ℹ️ Ma'lumot yoki hech qanday notification kanali (Telegram/brauzer) ulanmagan. O'tkazib yuborildi.");
    return;
  }

  const metaRef = db.ref('cycleTrackerMeta/lastNotified');
  const metaSnap = await metaRef.once('value');
  const lastNotified = metaSnap.val() || {};

  const now = tashkentNow();
  const todayStr = fmt(now);
  const notif = data.notifications || {};
  const updates = {};

  console.log(`⏰ Tekshirilmoqda: ${now.toISOString()} (Tashkent vaqti: ${todayStr} ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')})`);

  // 1) Next period reminder — 2 kun oldin, kuniga bir marta
  if (notif.nextPeriod) {
    const nextP = nextPeriodDate(data, now);
    const daysUntil = daysBetween(now, nextP);
    if (daysUntil === 2 && lastNotified.nextPeriod !== todayStr) {
      const sent = await sendBoth(data, '🩸 Hayzingiz yaqinlashmoqda', '2 kundan keyin hayzingiz boshlanishi kutilmoqda.');
      if (sent) updates.nextPeriod = todayStr;
    }
  }

  // 2) Ovulation reminder — 1 kun oldin, kuniga bir marta
  if (notif.ovulation) {
    const ovDate = predictedOvulationDate(data, todayStr, now);
    const daysUntil = daysBetween(now, ovDate);
    if (daysUntil === 1 && lastNotified.ovulation !== todayStr) {
      const sent = await sendBoth(data, '✨ Ovulyatsiya yaqinlashmoqda', 'Ertaga taxminiy ovulyatsiya kuningiz.');
      if (sent) updates.ovulation = todayStr;
    }
  }

  // 3) Daily check — har kuni soat 20:00 da
  if (notif.dailyCheck) {
    if (now.getHours() === 20 && lastNotified.dailyCheck !== todayStr) {
      const sent = await sendBoth(data, '📝 Kunlik holatingizni yozing', "Bugungi kayfiyat, uyqu, energiya va alomatlarni belgilashni unutmang.");
      if (sent) updates.dailyCheck = todayStr;
    }
  }

  // 4) Symptom reminder — hayz kunlarida, ertalab soat 9 atrofida
  if (notif.symptom) {
    const onPeriod = isPeriodDay(data.periodDays, todayStr);
    if (onPeriod && now.getHours() === 9 && lastNotified.symptom !== todayStr) {
      const sent = await sendBoth(data, '🩸 Bugun hayz kuningiz', "Alomat va his-tuyg'ularingizni ilovaga yozib qo'ying.");
      if (sent) updates.symptom = todayStr;
    }
  }

  if (Object.keys(updates).length) {
    await metaRef.update(updates);
    console.log('✓ lastNotified yangilandi:', updates);
  } else {
    console.log('Hozircha yuboriladigan eslatma yo\'q.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('❌ Kutilmagan xato:', e); process.exit(1); });
