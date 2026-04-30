// Polyfill globalThis.crypto for Node 18 (Baileys uses WebCrypto via globalThis.crypto,
// which only exists as a global from Node 19+). Without this, every Baileys
// connection attempt closes immediately with errMsg: "crypto is not defined".
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const GEMINI_KEY            = process.env.GEMINI_KEY || '';
const HUMAN_HANDOFF_NUMBER  = process.env.HUMAN_HANDOFF_NUMBER || ''; // e.g. 919876543210@s.whatsapp.net
const PACKAGES_CSV_URL      = process.env.PACKAGES_CSV_URL || '';     // published Google Sheet CSV
const PORT                  = process.env.PORT || 3000;
const HISTORY_LIMIT         = 6; // 3 user + 3 bot messages
const SESSION_DIR           = path.join(process.cwd(), 'auth_session');
const RECONNECT_BACKOFF_MS  = 3000;

// ─── SAFETY: don't let Baileys teardown crashes kill the process ───────────
process.on('uncaughtException', (e) => {
  console.error('⚠️  uncaughtException:', e?.message || e);
});
process.on('unhandledRejection', (e) => {
  console.error('⚠️  unhandledRejection:', e?.message || e);
});

// ─── AI SETUP ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
// systemInstruction belongs HERE (on getGenerativeModel), not on startChat.
// We use a function so it's evaluated lazily once packages load.
function getModel(systemInstruction) {
  return genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction,
  });
}

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Priya, a friendly travel consultant for Dream Travels, based in India.

## Personality
- Warm, helpful, never pushy
- Use Hindi-English mix when the customer does (e.g. "Bahut accha choice!")
- Keep messages SHORT — 2-4 lines max. This is WhatsApp, not email.
- Use 1-2 emojis max per message, never spam
- Ask ONE question at a time. Build rapport naturally.

## Rules
- Never quote prices unless the customer explicitly asks
- For destinations not in the package list below: say "Let me check with my team and get back to you!" then add [HANDOFF] on a new line
- For discount requests: say "I'll see what we can arrange — let me connect you with my senior!" then add [HANDOFF] on a new line
- When lead is ready to book, confirms dates, asks about payment, or wants to speak to a human: add [HANDOFF] on a new line at the very end of your reply
- Never invent packages, prices, or details not in the data provided
- Keep your reply conversational — never bullet-point everything, it looks robotic on WhatsApp`;

// ─── PACKAGE CACHE (Google Sheets CSV) ─────────────────────────────────────
let packagesCache = { data: '', fetchedAt: 0 };

async function getPackages() {
  if (!PACKAGES_CSV_URL) return '';
  const now = Date.now();
  if (packagesCache.data && (now - packagesCache.fetchedAt) < 5 * 60 * 1000) {
    return packagesCache.data;
  }
  try {
    const res = await fetch(PACKAGES_CSV_URL);
    const body = await res.text();

    // Detect if Google Sheets returned HTML (editor URL) instead of CSV.
    // Published CSV URLs return text/csv with no HTML markup; the editor
    // URL returns the full HTML viewer page which would poison the prompt.
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const looksHtml = body.trimStart().startsWith('<') || ct.includes('html');
    if (looksHtml) {
      console.error(`⚠️  PACKAGES_CSV_URL returned HTML, not CSV. Got content-type="${ct}". ` +
        `Fix: in Google Sheets use File → Share → Publish to web → CSV, then paste THAT url ` +
        `(should look like https://docs.google.com/spreadsheets/d/e/.../pub?output=csv).`);
      return packagesCache.data || '';
    }

    packagesCache = { data: body, fetchedAt: now };
    console.log(`✅ Packages refreshed from Google Sheets (${body.length} bytes)`);
    return body;
  } catch (e) {
    console.error('⚠️  Failed to fetch packages:', e.message);
    return packagesCache.data || '';
  }
}

// ─── IN-MEMORY STORAGE ─────────────────────────────────────────────────────
const memory = {};
let latestQR = null;

// ─── WHATSAPP STATE ─────────────────────────────────────────────────────────
let sock;
let isConnecting = false;     // single-flight guard
let reconnectTimer = null;    // backoff timer

// Tear down the current socket without throwing. Critically: attach a no-op
// 'error' listener to the underlying WebSocket so that a "WebSocket was closed
// before the connection was established" event doesn't bubble up as unhandled.
function safeSocketTeardown() {
  try {
    if (!sock) return;
    try { sock.ev?.removeAllListeners?.(); } catch (_) {}
    try { sock.ws?.on?.('error', () => {}); } catch (_) {}
    try { sock.ws?.removeAllListeners?.('open'); } catch (_) {}
    try { sock.end?.(undefined); } catch (_) {}
  } catch (_) {}
}

// Wipe CONTENTS of the auth folder, never the folder itself.
// On Railway the folder is a volume mount point — rmdir on it always fails
// with EBUSY. We only delete files/subdirs inside.
function wipeAuthSession() {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
      console.log('🗑️  Auth dir created (was missing)');
      return;
    }
    let removed = 0;
    for (const entry of fs.readdirSync(SESSION_DIR, { withFileTypes: true })) {
      const full = path.join(SESSION_DIR, entry.name);
      try {
        if (entry.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        } else {
          fs.unlinkSync(full);
        }
        removed++;
      } catch (e) {
        console.error(`Wipe entry failed (${entry.name}):`, e.message);
      }
    }
    console.log(`🗑️  Cleared ${removed} auth entry/entries from ${SESSION_DIR}`);
  } catch (e) {
    console.error('Wipe error:', e.message);
  }
}

function scheduleReconnect(delayMs = RECONNECT_BACKOFF_MS) {
  if (reconnectTimer) return; // already pending
  console.log(`⏳ Reconnect scheduled in ${delayMs}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp().catch((err) =>
      console.error('Reconnect failed:', err?.message || err)
    );
  }, delayMs);
}

async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('⏳ connectToWhatsApp already in progress — skipping duplicate call');
    return;
  }
  isConnecting = true;

  try {
    // Tear down any prior socket cleanly (no thrown errors)
    safeSocketTeardown();

    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    // Pin to the LATEST WhatsApp Web protocol version. Baileys 6.7.9 ships
    // with a hardcoded version that's now stale and WhatsApp silently rejects
    // the handshake, causing instant connection close + no QR.
    let version;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
      console.log(`📦 Baileys WA version: ${version.join('.')} (isLatest: ${fetched.isLatest})`);
    } catch (e) {
      console.error('Could not fetch latest WA version, using default:', e?.message || e);
    }

    sock = makeWASocket({
      version,
      auth: state,
      // pino at 'warn' so Baileys errors surface in Railway logs (was 'silent')
      logger: pino({ level: 'warn' }),
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60_000,
    });

    // Defense-in-depth: silence any raw WebSocket errors so they don't crash node
    try { sock.ws?.on?.('error', (e) => console.error('ws error:', e?.message || e)); } catch (_) {}

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      // Log every connection.update so we can see what Baileys is actually doing
      const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
      console.log('🔌 connection.update:', JSON.stringify({
        connection,
        hasQR: Boolean(qr),
        statusCode: lastDisconnect?.error?.output?.statusCode,
        errMsg: lastDisconnect?.error?.message,
        isNewLogin,
        receivedPendingNotifications,
      }));

      if (qr) {
        latestQR = qr;
        console.log('\n📱 QR ready — open /qr in your browser to scan it!');
        try { qrcode.generate(qr, { small: true }); } catch (_) {}
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`Connection closed (code=${code}). Reconnecting: ${shouldReconnect}`);
        if (shouldReconnect) scheduleReconnect();
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected!');
        latestQR = null;
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      if (from.endsWith('@g.us')) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text.trim()) return;
      if (memory[from]?.handedOff) return;

      console.log(`[${from}] Customer: ${text}`);
      await handleIncoming(from, text);
    });
  } finally {
    isConnecting = false;
  }
}

// ─── CORE HANDLER ──────────────────────────────────────────────────────────
async function handleIncoming(from, userMessage) {
  if (!memory[from]) memory[from] = { history: [], handedOff: false };
  const userMem = memory[from];

  const packagesData = await getPackages();
  const fullPrompt = packagesData
    ? `${SYSTEM_PROMPT}\n\n## Current Packages (use ONLY these)\n\n${packagesData}`
    : SYSTEM_PROMPT;

  const chatHistory = userMem.history.map((m) => ({
    role: m.role,
    parts: [{ text: m.content }],
  }));

  try {
    // Build a model with the system prompt baked in (correct API placement)
    const model = getModel(fullPrompt);
    const chat = model.startChat({ history: chatHistory });

    const result = await chat.sendMessage(userMessage);
    let reply = (result.response.text() || '').trim();
    if (!reply) {
      console.error(`⚠️  Empty Gemini reply for [${from}]. Falling back.`);
      reply = "I'm here! Could you tell me a bit more about what you're looking for? 😊";
    }

    console.log(`[${from}] Priya: ${reply}`);

    userMem.history.push({ role: 'user', content: userMessage });

    if (reply.includes('[HANDOFF]')) {
      reply = reply.replace('[HANDOFF]', '').trim();
      userMem.handedOff = true;

      if (HUMAN_HANDOFF_NUMBER) {
        try {
          await sock.sendMessage(HUMAN_HANDOFF_NUMBER, {
            text: `🔥 *Hot Lead — Ready for Handoff*\n\n📞 Number: ${from.replace('@s.whatsapp.net', '')}\n💬 Last message: "${userMessage}"`,
          });
          console.log('🔥 Handoff notification sent!');
        } catch (e) {
          console.error('Handoff notification failed:', e.message);
        }
      }
    }

    await sock.sendMessage(from, { text: reply });

    userMem.history.push({ role: 'model', content: reply });

    if (userMem.history.length > HISTORY_LIMIT) {
      userMem.history = userMem.history.slice(-HISTORY_LIMIT);
    }
  } catch (e) {
    // Truncate so a huge HTML/JSON dump doesn't pollute logs
    const trimmed = (e?.message || String(e)).slice(0, 500);
    console.error('AI error:', trimmed);
    if (e?.stack) console.error('AI error stack:', e.stack.slice(0, 800));
    try {
      await sock.sendMessage(from, {
        text: "Sorry, I'm having a little trouble right now! I'll get back to you shortly. 😊",
      });
    } catch (_) {}
  }
}

// ─── EXPRESS SERVER ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Priya bot is running ✅'));

// Diagnostic endpoint — useful to check live state without waiting for logs
app.get('/status', (req, res) => {
  res.json({
    hasQR: Boolean(latestQR),
    isConnecting,
    reconnectPending: Boolean(reconnectTimer),
    sessionFiles: fs.existsSync(SESSION_DIR) ? fs.readdirSync(SESSION_DIR) : [],
    activeUsers: Object.keys(memory).length,
  });
});

app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send(`<html><head><meta http-equiv="refresh" content="5"></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;background:#111;color:#fff">
      <h2>⏳ Waiting for QR...</h2>
      <p style="color:#aaa">If this stays here, the bot has a stale session.</p>
      <p><a href="/reset" style="color:#e74c3c;font-size:18px;font-weight:bold">👉 Click here to reset & get fresh QR</a></p>
      <p style="color:#555;font-size:13px">Page auto-refreshes every 5 seconds · <a href="/status" style="color:#888">/status</a></p>
    </body></html>`);
  }
  try {
    const qrImage = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
    res.send(`<html><head><meta http-equiv="refresh" content="20"></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff">
      <h2>📱 Scan with WhatsApp</h2>
      <p style="color:#aaa">Open WhatsApp → Linked Devices → Link a Device → scan below</p>
      <img src="${qrImage}" style="border-radius:12px;margin:20px auto;display:block"/>
      <p style="color:#888;font-size:13px">Auto-refreshes every 20 sec. <a href="/qr" style="color:#25d366">Refresh now</a></p>
    </body></html>`);
  } catch (e) {
    res.status(500).send('Error generating QR');
  }
});

// In-process reset — wipes auth contents, tears down socket, reconnects
app.get('/reset', async (req, res) => {
  console.log('🔄 In-process reset triggered');

  // Cancel any pending reconnect first
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  safeSocketTeardown();
  wipeAuthSession();

  latestQR = null;
  for (const k of Object.keys(memory)) delete memory[k];

  res.send(`<html><head><meta http-equiv="refresh" content="6;url=/qr"></head>
  <body style="font-family:sans-serif;text-align:center;padding:60px;background:#111;color:#fff">
    <h2>🔄 Reset complete</h2>
    <p style="color:#aaa">Reconnecting to WhatsApp — fresh QR in a few seconds.</p>
    <p><a href="/qr" style="color:#25d366">Go to QR page</a></p>
  </body></html>`);

  // Reconnect after the response flushes — gives Baileys' teardown time
  setTimeout(() => {
    connectToWhatsApp().catch((err) =>
      console.error('Reconnect failed:', err?.message || err)
    );
  }, 1500);
});

// Webhook: trigger bot to message a new lead (e.g. from your website form)
app.post('/new-lead', async (req, res) => {
  try {
    const { name, phone, destination, dates, travelers } = req.body;
    const cleanPhone = String(phone).replace(/\D/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;

    const firstMessage = `Hi ${name || 'there'}! 👋 Thanks for your interest${destination ? ` in ${destination}` : ''}. I'm Priya from Dream Travels — here to help you plan the perfect trip! Are you still looking at${dates ? ` ${dates}` : ' those dates'}?`;

    await sock.sendMessage(jid, { text: firstMessage });

    memory[jid] = {
      history: [{ role: 'model', content: firstMessage }],
      handedOff: false,
    };

    console.log(`📥 New lead initiated for ${jid}`);
    res.json({ success: true });
  } catch (e) {
    console.error('New lead error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// ─── START ──────────────────────────────────────────────────────────────────
connectToWhatsApp().catch((err) =>
  console.error('Initial connect failed:', err?.message || err)
);
