const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
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

// ─── AI SETUP ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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
    const csv = await res.text();
    packagesCache = { data: csv, fetchedAt: now };
    console.log('✅ Packages refreshed from Google Sheets');
    return csv;
  } catch (e) {
    console.error('⚠️  Failed to fetch packages:', e.message);
    return packagesCache.data || '';
  }
}

// ─── IN-MEMORY STORAGE ─────────────────────────────────────────────────────
// { "9190000@s.whatsapp.net": { history: [...], handedOff: false } }
const memory = {};

// Latest QR code (stored so /qr page can serve it)
let latestQR = null;

// ─── WHATSAPP ───────────────────────────────────────────────────────────────
let sock;

async function connectToWhatsApp() {
  // Clean up any prior socket so listeners don't pile up across resets
  try { if (sock) { sock.ev.removeAllListeners(); sock.end(undefined); } } catch (_) {}

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      console.log('\n📱 QR ready — open /qr in your browser to scan it!');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      latestQR = null;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    // Ignore group messages
    if (from.endsWith('@g.us')) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!text.trim()) return;

    // Skip if already handed off to human
    if (memory[from]?.handedOff) return;

    console.log(`[${from}] Customer: ${text}`);
    await handleIncoming(from, text);
  });
}

// ─── CORE HANDLER ──────────────────────────────────────────────────────────
async function handleIncoming(from, userMessage) {
  if (!memory[from]) memory[from] = { history: [], handedOff: false };
  const userMem = memory[from];

  // Fetch live packages from Google Sheet
  const packagesData = await getPackages();
  const fullPrompt = packagesData
    ? `${SYSTEM_PROMPT}\n\n## Current Packages (use ONLY these)\n\n${packagesData}`
    : SYSTEM_PROMPT;

  // Build Gemini chat history
  const chatHistory = userMem.history.map((m) => ({
    role: m.role,
    parts: [{ text: m.content }],
  }));

  try {
    const chat = model.startChat({
      history: chatHistory,
      systemInstruction: fullPrompt,
    });

    const result = await chat.sendMessage(userMessage);
    let reply = result.response.text().trim();

    console.log(`[${from}] Priya: ${reply}`);

    // Save user message to history
    userMem.history.push({ role: 'user', content: userMessage });

    // Check for handoff signal
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

    // Send reply to customer
    await sock.sendMessage(from, { text: reply });

    // Save bot reply to history
    userMem.history.push({ role: 'model', content: reply });

    // Trim to last N messages
    if (userMem.history.length > HISTORY_LIMIT) {
      userMem.history = userMem.history.slice(-HISTORY_LIMIT);
    }
  } catch (e) {
    console.error('AI error:', e.message);
    await sock.sendMessage(from, {
      text: "Sorry, I'm having a little trouble right now! I'll get back to you shortly. 😊",
    });
  }
}

// ─── EXPRESS SERVER ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('Priya bot is running ✅'));

// QR code page — open this in browser to scan
app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send(`<html><head><meta http-equiv="refresh" content="5"></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;background:#111;color:#fff">
      <h2>⏳ Waiting for QR...</h2>
      <p style="color:#aaa">If this stays here, the bot has a stale session.</p>
      <p><a href="/reset" style="color:#e74c3c;font-size:18px;font-weight:bold">👉 Click here to reset & get fresh QR</a></p>
      <p style="color:#555;font-size:13px">Page auto-refreshes every 5 seconds</p>
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

// In-process reset — wipes auth, tears down socket, reconnects without exiting
app.get('/reset', async (req, res) => {
  console.log('🔄 In-process reset triggered');
  const sessionDir = path.join(process.cwd(), 'auth_session');

  // Tear down existing socket so listeners don't double up
  try {
    if (sock) {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    }
  } catch (e) {
    console.error('Socket teardown error:', e.message);
  }

  // Wipe auth folder (recursive — handles any subdirs Baileys created)
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('🗑️  Auth session cleared');
    }
  } catch (e) {
    console.error('Wipe error:', e.message);
  }

  // Clear cached QR + per-user memory
  latestQR = null;
  for (const k of Object.keys(memory)) delete memory[k];

  res.send(`<html><head><meta http-equiv="refresh" content="6;url=/qr"></head>
  <body style="font-family:sans-serif;text-align:center;padding:60px;background:#111;color:#fff">
    <h2>🔄 Reset complete</h2>
    <p style="color:#aaa">Reconnecting to WhatsApp — fresh QR in a few seconds.</p>
    <p><a href="/qr" style="color:#25d366">Go to QR page</a></p>
  </body></html>`);

  // Reconnect after the response flushes — no process exit, no Railway restart needed
  setTimeout(() => {
    connectToWhatsApp().catch((err) => console.error('Reconnect failed:', err));
  }, 1000);
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
connectToWhatsApp();
