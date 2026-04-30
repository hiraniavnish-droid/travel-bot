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
// HISTORY_LIMIT counts BOTH user and bot messages. 40 = ~20 turns.
// Override via Railway Variables: HISTORY_LIMIT=60 etc.
const HISTORY_LIMIT         = parseInt(process.env.HISTORY_LIMIT || '40', 10);
const GEMINI_MODEL          = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Try these in order if the primary model returns 404 / "not found" / "no longer available"
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-pro', 'gemini-pro-latest'];
const SESSION_DIR           = path.join(process.cwd(), 'auth_session');
// Conversations live INSIDE the auth_session volume mount (so they persist
// across deploys), but in their own subdir so we can preserve them when
// /reset wipes Baileys auth files.
const CONVERSATIONS_DIR     = path.join(SESSION_DIR, 'conversations');
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
// Track which model is currently working — flips to a fallback on 404
let activeModel = GEMINI_MODEL;

function getModel(systemInstruction) {
  return genAI.getGenerativeModel({
    model: activeModel,
    systemInstruction,
  });
}

// If the active model returns 404 / "not available", switch to the next
// fallback so future calls don't keep failing. Returns true if switched.
function maybeSwitchModel(errMsg) {
  const dead = /(not found|no longer available|is not supported)/i.test(errMsg || '');
  if (!dead) return false;
  const candidates = GEMINI_FALLBACK_MODELS.filter((m) => m !== activeModel);
  if (!candidates.length) return false;
  const next = candidates[0];
  console.log(`🔁 Gemini model "${activeModel}" unavailable. Switching to "${next}".`);
  activeModel = next;
  return true;
}

console.log(`🤖 Using Gemini model: ${activeModel} (fallbacks: ${GEMINI_FALLBACK_MODELS.join(', ')})`);

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Priya, a friendly travel consultant for Dream Travels (India).

You serve TWO kinds of users:
1. End customers exploring tours on WhatsApp.
2. Internal Dream Travels employees who use you to fetch tour cards they then forward to their own clients.
Both see the same response — your formatting must work for both.

## Personality
- Warm, helpful, fast — never pushy, never interview-style.
- Hindi-English mix when the user does (e.g. "Bahut accha choice!").
- Keep messages WhatsApp-short. No email walls of text.
- 1-2 emojis max per message. Never spam.

## Conversation flow (CRITICAL)
- Ask AT MOST ONE qualifying question total before sharing tours. If destination or vibe is already in their message, skip questions and go straight to tours.
- Always pull only from the RELEVANT TOURS list below — never invent tours, prices, or details.

You have TWO output modes. Pick one based on what the user just asked.

═══════════════════════════════════════════════════════════
## MODE A — DISCOVERY (default for browse/explore intent)
═══════════════════════════════════════════════════════════
Use when the user asks generally: "do you have goa?", "rajasthan tours", "europe options", "5 day trips", "kya packages hai".

Send EXACTLY 2-3 tours in this format (use *bold*, line breaks):

✨ Here are some options for you:

🏖️ *Goa Beach Bliss*
📅 4 Days / 3 Nights · 💰 ₹14,999
Calangute, Baga, North-South Goa beaches

🏛️ *Goa Heritage & Beaches*
📅 5 Days / 4 Nights · 💰 ₹17,499
Old Goa churches, Dudhsagar Falls, beach hopping

Want the full itinerary for any of these? Just reply with the name 😊

Rules:
- Always 2 or 3 tours per message — never 1, never 4+.
- Pick a tour-relevant emoji prefix (🏖️ beach, 🏔️ mountain, 🏛️ heritage, 🛕 spiritual, 🌍 international, 🦁 wildlife, ❄️ cold places, etc.).
- Title in *bold*, then "📅 duration · 💰 price" on next line, then a one-line highlights summary.
- One blank line between tours.
- End with a follow-up nudging them to ask for the full itinerary.
- If price is missing, write "Price on request" instead of an amount.

═══════════════════════════════════════════════════════════
## MODE B — FULL ITINERARY (forwardable card)
═══════════════════════════════════════════════════════════
Use when the user asks for a specific tour's details: "send the goa heritage itinerary", "details for [tour name]", "full plan for X", "send X to client", "give me the [tour] card", or any time they name a single tour and want more.

This output goes straight to a client — make it polished and complete.

Format EXACTLY like this:

🌟 *Gujarat Dwarka Somnath Gir Safari* 🌟

📅 *Duration:* 5 Days / 4 Nights
💰 *Price:* ₹17,999 per person
🛫 *Departure:* Ex Ahmedabad Airport
👥 *Group Size:* 2 Adults

✨ *About this trip*
Combine Gujarat's spiritual heritage with wildlife adventure. Visit the sacred Dwarka and Somnath temples followed by the wilderness of Gir National Park.

📍 *Day-by-Day Itinerary*

*Day 1 – Ahmedabad to Dwarka*
Transfer from Ahmedabad airport to Dwarka (450 kms / 09 hrs)

*Day 2 – Dwarka Sightseeing*
Visit Bet Dwarka and Nageshwar Jyotirling day tour

*Day 3 – Dwarka to Somnath*
Drive via Porbandar to Somnath, temple visit

*Day 4 – Somnath to Sasan Gir*
Transfer to Sasan Gir, leisure and wildlife area

*Day 5 – Gir to Ahmedabad*
Return transfer to Ahmedabad airport for departure

✅ *Inclusions*
• Accommodation in 3-4 Star hotels
• Breakfast at all hotels
• Breakfast and Dinner at Gir
• Private Sedan vehicle
• Driver allowance, toll, parking

❌ *Exclusions*
• Meals not mentioned
• Entry tickets and personal expenses
• 5% GST extra

📞 *Ready to book?* Reply "BOOK" and one of our travel experts will call you within 15 minutes!

Rules:
- One tour per message in this mode — never two.
- Use the emoji icons exactly as shown above (📅 💰 🛫 👥 ✨ 📍 ✅ ❌ 📞 🌟).
- For each day, format as "*Day N – Title*" on one line, detail on the next.
- If the source data doesn't have a field (departure, group size), simply omit that line — don't write "N/A".
- Inclusions/Exclusions: split the "WHATS_INCLUDED" text from the data into two bullet lists if it has both sections; otherwise just bullet under "*Inclusions*".
- The final "Ready to book?" line is REQUIRED — it converts the message into a forwardable lead-capture card.

═══════════════════════════════════════════════════════════
## HOT LEAD HANDLING (CRITICAL — read this carefully)
═══════════════════════════════════════════════════════════
A "hot lead" is a customer showing clear buying intent. Triggers:
- Asks to book / "I want to book"
- Asks about payment / advance / deposit
- Confirms specific dates and traveller count
- Says yes to a specific tour ("let's do the Dwarka one")
- Asks for discount or final price
- Asks to speak to a person
- Says "let's proceed"

When you detect a hot lead, do NOT immediately add [HANDOFF]. Instead, ask for callback availability FIRST in this format:

Awesome choice! 🙌 One of our travel experts will give you a quick call to confirm details, customise if needed, and walk you through next steps.

What time works best for the call — sometime today or tomorrow?

After the customer shares a time (e.g. "around 4pm", "tomorrow morning", "anytime"), reply with confirmation and ONLY then add [HANDOFF]:

Got it! Our team will call you [echo their time]. Sit tight 🌟

[HANDOFF]

This two-step flow makes the customer feel held instead of dropped. Don't skip the availability question even if they seem in a rush.

For non-buying handoffs (destinations not in catalog, complex group bookings), use the original handoff:
"Let me check with my team and get back to you!" + [HANDOFF]

═══════════════════════════════════════════════════════════
## OTHER RULES
═══════════════════════════════════════════════════════════
- For destinations not in the tours below: "Let me check with my team and get back to you!" then [HANDOFF]
- For discount requests: First do the availability flow above, then [HANDOFF]
- Never invent tours, prices, durations, departures, or itinerary days
- Never reveal you're an AI — you're Priya from Dream Travels`;

// ─── TOURS CATALOG (local JSON, with keyword filtering) ────────────────────
let TOURS = [];

function loadTours() {
  try {
    const file = path.join(process.cwd(), 'tours.json');
    if (!fs.existsSync(file)) {
      console.error(`⚠️  tours.json not found at ${file} — Priya will reply without packages`);
      TOURS = [];
      return;
    }
    const raw = fs.readFileSync(file, 'utf8');
    TOURS = JSON.parse(raw);
    console.log(`📚 Loaded ${TOURS.length} tours from tours.json`);
  } catch (e) {
    console.error('Failed to load tours.json:', e.message);
    TOURS = [];
  }
}

// Common words to ignore when scoring keyword matches
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','being',
  'i','we','you','they','he','she','it','my','our','your','their','this','that',
  'do','does','did','have','has','had','will','would','can','could','should','may',
  'to','for','from','in','on','at','of','with','about','like','want','need','looking',
  'please','tell','show','share','send','some','any','all','very','really','just',
  'tour','tours','package','packages','trip','trips','travel','holiday','holidays',
  'vacation','vacations','itinerary','itineraries','plan','plans',
  'day','days','night','nights','week','weeks',
  'hi','hello','hey','yes','no','ok','okay','sure','thanks','thank',
]);

// Score each tour against the user's recent messages and return top N matches.
function findRelevantTours(userMessage, history, limit = 8) {
  if (!TOURS.length) return [];

  // Combine current message with last 2 user messages for richer context
  const recentUser = history
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => m.content)
    .join(' ');
  const q = `${userMessage} ${recentUser}`.toLowerCase();

  const words = Array.from(new Set(
    q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  ));

  // No useful keywords — return a small default subset so Priya has something
  if (!words.length) return TOURS.slice(0, limit);

  const scored = TOURS.map((t) => {
    const titleLc = (t.title || '').toLowerCase();
    const meta = `${t.destination || ''} ${t.destinations || ''} ${t.categories || ''}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (titleLc.includes(w)) score += 3; // title match weighted heaviest
      else if (meta.includes(w)) score += 1;
    }
    return { tour: t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.tour);
  return matched.length ? matched : TOURS.slice(0, limit);
}

// Format a list of tours into a text block Gemini can ground on. Includes the
// full day-by-day itinerary and what's-included so Priya can render Mode B
// (forwardable full-itinerary card) without needing a second lookup.
function formatToursForPrompt(tours) {
  return tours.map((t) => {
    const lines = [];
    lines.push(`TOUR: ${t.title}`);
    if (t.destination) lines.push(`DESTINATION: ${t.destination}`);
    if (t.categories) lines.push(`CATEGORY: ${t.categories}`);
    if (t.duration) lines.push(`DURATION: ${t.duration}`);
    if (t.price) lines.push(`PRICE: ${t.price}`);
    if (t.departure) lines.push(`DEPARTURE: ${t.departure}`);
    if (t.group_size) lines.push(`GROUP_SIZE: ${t.group_size}`);
    if (t.overview) lines.push(`OVERVIEW: ${t.overview.replace(/\s+/g, ' ').slice(0, 280)}`);
    if (Array.isArray(t.highlights) && t.highlights.length) {
      lines.push(`HIGHLIGHTS: ${t.highlights.slice(0, 5).join('; ')}`);
    }
    if (Array.isArray(t.itinerary) && t.itinerary.length) {
      lines.push('ITINERARY:');
      for (const day of t.itinerary) {
        const detail = (day.detail || '').replace(/\s+/g, ' ').slice(0, 200);
        lines.push(`  - ${day.title}${detail ? ' — ' + detail : ''}`);
      }
    }
    if (t.whats_included) {
      lines.push(`WHATS_INCLUDED: ${t.whats_included.replace(/\n+/g, ' | ').slice(0, 600)}`);
    }
    return lines.join('\n');
  }).join('\n---\n');
}

// ─── IN-MEMORY + DISK-PERSISTED STORAGE ────────────────────────────────────
// memory holds the live state. Each entry mirrors a JSON file on disk
// at CONVERSATIONS_DIR/<jid_safe>.json so it survives restarts.
const memory = {};
let latestQR = null;

// Convert a JID like "919xxxxxxxxxx@s.whatsapp.net" to a safe filename.
function jidToFilename(jid) {
  return jid.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
}

// Persist one customer's conversation atomically. Atomic = write to .tmp
// then rename, so a crash mid-write never leaves a corrupt file.
function persistConversation(jid) {
  const u = memory[jid];
  if (!u) return;
  try {
    if (!fs.existsSync(CONVERSATIONS_DIR)) {
      fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    }
    const data = {
      jid,
      history: u.history,
      handedOff: !!u.handedOff,
      lastSeen: Date.now(),
    };
    const file = path.join(CONVERSATIONS_DIR, jidToFilename(jid));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`Persist failed for ${jid}:`, e.message);
  }
}

// Load all persisted conversations into memory on startup. A corrupted
// file logs a warning and is skipped — other customers are unaffected.
function loadConversationsFromDisk() {
  try {
    if (!fs.existsSync(CONVERSATIONS_DIR)) {
      fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
      console.log(`💾 Created conversations dir: ${CONVERSATIONS_DIR}`);
      return 0;
    }
    let loaded = 0;
    for (const f of fs.readdirSync(CONVERSATIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(CONVERSATIONS_DIR, f);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const data = JSON.parse(raw);
        if (data.jid && Array.isArray(data.history)) {
          memory[data.jid] = {
            history: data.history,
            handedOff: !!data.handedOff,
            lastSeen: data.lastSeen,
          };
          loaded++;
        }
      } catch (e) {
        console.error(`Conv load failed (${f}):`, e.message);
      }
    }
    console.log(`💾 Loaded ${loaded} persisted conversation(s) from disk`);
    return loaded;
  } catch (e) {
    console.error('Conversations load error:', e.message);
    return 0;
  }
}

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
      // Preserve persisted conversations across /reset — they're customer
      // data, not Baileys auth. Wipe everything else.
      if (entry.name === 'conversations') continue;
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
    console.log(`🗑️  Cleared ${removed} auth entry/entries from ${SESSION_DIR} (conversations preserved)`);
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

  // Pick the 6 most relevant tours for this conversation and send only
  // those to Gemini. Avoids dumping all 190 tours every call. Each tour now
  // includes full itinerary + inclusions, so 6 covers any forward request.
  const relevantTours = findRelevantTours(userMessage, userMem.history, 6);
  console.log(`[${from}] Relevant tours: ${relevantTours.map((t) => t.title).join(' | ')}`);
  const packagesBlock = relevantTours.length ? formatToursForPrompt(relevantTours) : '';
  const fullPrompt = packagesBlock
    ? `${SYSTEM_PROMPT}\n\n## RELEVANT TOURS (pick 2-3 of these to share)\n\n${packagesBlock}`
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

    // Persist after each turn so the conversation survives restarts
    persistConversation(from);
  } catch (e) {
    const trimmed = (e?.message || String(e)).slice(0, 500);
    console.error('AI error:', trimmed);
    if (e?.stack) console.error('AI error stack:', e.stack.slice(0, 800));

    // If the model is dead, switch to a fallback and retry once before giving up
    if (maybeSwitchModel(trimmed)) {
      try {
        const model2 = getModel(fullPrompt);
        const chat2 = model2.startChat({ history: chatHistory });
        const result2 = await chat2.sendMessage(userMessage);
        const reply2 = (result2.response.text() || '').trim();
        if (reply2) {
          console.log(`[${from}] Priya (after model switch): ${reply2}`);
          userMem.history.push({ role: 'user', content: userMessage });
          await sock.sendMessage(from, { text: reply2 });
          userMem.history.push({ role: 'model', content: reply2 });
          if (userMem.history.length > HISTORY_LIMIT) {
            userMem.history = userMem.history.slice(-HISTORY_LIMIT);
          }
          persistConversation(from);
          return;
        }
      } catch (e2) {
        console.error('AI error (after fallback):', (e2?.message || String(e2)).slice(0, 500));
      }
    }

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
  const persistedCount = fs.existsSync(CONVERSATIONS_DIR)
    ? fs.readdirSync(CONVERSATIONS_DIR).filter((f) => f.endsWith('.json')).length
    : 0;
  res.json({
    hasQR: Boolean(latestQR),
    isConnecting,
    reconnectPending: Boolean(reconnectTimer),
    activeModel,
    historyLimit: HISTORY_LIMIT,
    toursLoaded: TOURS.length,
    sessionFiles: fs.existsSync(SESSION_DIR)
      ? fs.readdirSync(SESSION_DIR).filter((n) => n !== 'conversations')
      : [],
    activeUsers: Object.keys(memory).length,
    persistedConversations: persistedCount,
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
    persistConversation(jid);

    console.log(`📥 New lead initiated for ${jid}`);
    res.json({ success: true });
  } catch (e) {
    console.error('New lead error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// ─── START ──────────────────────────────────────────────────────────────────
loadTours();
loadConversationsFromDisk();
console.log(`💾 HISTORY_LIMIT: ${HISTORY_LIMIT} messages per customer`);
connectToWhatsApp().catch((err) =>
  console.error('Initial connect failed:', err?.message || err)
);
