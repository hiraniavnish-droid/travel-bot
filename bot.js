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

// ─── ANTI-BAN: OUTBOUND RATE LIMIT + HUMAN-LIKE TIMING ─────────────────────
// Why this exists:
// 1) A runaway loop on a Gemini error (or any logic bug) could fire dozens
//    of messages per second. WhatsApp's anti-spam systems treat that as a
//    bot signal regardless of intent. The token bucket caps us hard.
// 2) Replying in 200ms every time is itself a bot fingerprint. Real humans
//    have variable latency. We add Gaussian-distributed jitter and a
//    "typing…" presence so each outbound message looks human.
//
// Tunable via Railway Variables:
//   RATE_LIMIT_PER_MINUTE  (default 30) — global outbound message ceiling
//   REPLY_DELAY_MEAN_MS    (default 4000) — mean of the typing delay
//   REPLY_DELAY_STDDEV_MS  (default 1500) — stddev of the typing delay
//   REPLY_DELAY_MIN_MS     (default 2000) — clamp lower bound
//   REPLY_DELAY_MAX_MS     (default 8000) — clamp upper bound

const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30', 10);
const REPLY_DELAY_MEAN_MS   = parseInt(process.env.REPLY_DELAY_MEAN_MS   || '5500', 10);
const REPLY_DELAY_STDDEV_MS = parseInt(process.env.REPLY_DELAY_STDDEV_MS || '1200', 10);
const REPLY_DELAY_MIN_MS    = parseInt(process.env.REPLY_DELAY_MIN_MS    || '3500', 10);
const REPLY_DELAY_MAX_MS    = parseInt(process.env.REPLY_DELAY_MAX_MS    || '7500', 10);
// How often to re-emit the "composing" presence event so the typing
// indicator stays visible. WhatsApp clients can drop a stale indicator
// after a few seconds — re-emitting every ~2.5s keeps it on screen.
const TYPING_REFRESH_MS     = parseInt(process.env.TYPING_REFRESH_MS     || '2500', 10);
// Maximum number of separate WhatsApp messages Priya can emit in a single
// turn. Replies are split on the [NEXT] marker. If Gemini emits more chunks
// than this, the overflow is merged into the last allowed bubble. Acts as
// a hard ceiling against any "dump the whole catalog" loop.
const MAX_BUBBLES           = parseInt(process.env.MAX_BUBBLES           || '4', 10);

// Token bucket. Refills continuously at RATE_LIMIT_PER_MINUTE/60 tokens/sec.
let _rlTokens     = RATE_LIMIT_PER_MINUTE;
let _rlLastRefill = Date.now();
let _rlWaitCount  = 0; // how many times we had to wait — surfaced via /status

function _refillTokens() {
  const now = Date.now();
  const elapsedSec = (now - _rlLastRefill) / 1000;
  if (elapsedSec <= 0) return;
  const refill = elapsedSec * (RATE_LIMIT_PER_MINUTE / 60);
  if (refill > 0) {
    _rlTokens = Math.min(RATE_LIMIT_PER_MINUTE, _rlTokens + refill);
    _rlLastRefill = now;
  }
}

async function acquireSendToken() {
  // Block until a token is available. Worst-case wait ≈ 2s at 30/min.
  // Loops in case multiple senders are racing for the last token.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    _refillTokens();
    if (_rlTokens >= 1) {
      _rlTokens -= 1;
      return;
    }
    const need = 1 - _rlTokens;
    const waitMs = Math.max(100, Math.ceil((need / (RATE_LIMIT_PER_MINUTE / 60)) * 1000));
    _rlWaitCount += 1;
    console.log(`⏳ Outbound rate limit reached — waiting ${waitMs}ms before next send (waits=${_rlWaitCount})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Box-Muller transform → approximately normal distribution. Clamped to the
// configured min/max so we never hang the bot for 30s on a long tail draw.
function humanReplyDelayMs() {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = REPLY_DELAY_MEAN_MS + z * REPLY_DELAY_STDDEV_MS;
  return Math.max(REPLY_DELAY_MIN_MS, Math.min(REPLY_DELAY_MAX_MS, Math.round(ms)));
}

// safeSend: ALWAYS use this instead of sock.sendMessage for outbound.
// 1. acquires a global rate-limit token (blocks if bucket is empty)
// 2. emits "typing…" presence (composing)
// 3. waits a human-jittered delay
// 4. emits "online but not typing" presence (paused)
// 5. sends the message
//
// opts.skipTyping = true → skip steps 2-4. Use for internal handoff alerts
// where realism doesn't matter and speed does.
async function safeSend(jid, content, opts = {}) {
  await acquireSendToken();

  if (!opts.skipTyping) {
    // First "typing…" event
    try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}

    // Wait the human-like duration, but RE-EMIT composing every
    // TYPING_REFRESH_MS so the indicator stays visible the whole time.
    // (WhatsApp clients can hide a stale composing event after a few
    // seconds, which is why long single-shot waits felt like the typing
    // dot only flashed briefly.)
    const total = humanReplyDelayMs();
    let elapsed = 0;
    while (elapsed < total) {
      const slice = Math.min(TYPING_REFRESH_MS, total - elapsed);
      await new Promise((r) => setTimeout(r, slice));
      elapsed += slice;
      if (elapsed < total) {
        try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
      }
    }

    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  }

  return sock.sendMessage(jid, content);
}

// Sanitize chat history before handing it to Gemini's startChat().
// Gemini requires:
//   1. The first message must have role 'user' (a leading 'model' message
//      throws "First content should be with role 'user', got model").
//   2. Roles must strictly alternate user/model/user/model...
// Persisted conversations CAN end up violating these — e.g. /new-lead
// initiates with a model message, a Baileys fromMe event slips in during
// a restart, or a previous bug wrote an unexpected order.
// This function drops leading non-user entries and collapses consecutive
// same-role runs (keeps the first), then maps to Gemini's expected shape.
function sanitizeHistoryForGemini(history) {
  const out = [];
  for (const m of history || []) {
    if (!m || !m.content) continue;
    // Skip until we see the first 'user' message
    if (out.length === 0 && m.role !== 'user') continue;
    // Strict alternation — drop any consecutive same-role entries
    if (out.length > 0 && out[out.length - 1].role === m.role) continue;
    out.push({ role: m.role, content: m.content });
  }
  return out.map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}

// Multi-bubble replies are DISABLED. Every reply is sent as ONE WhatsApp
// message regardless of what the model outputs. If Gemini ever emits a
// [NEXT] marker (despite the prompt telling it not to), this function
// strips the marker and joins the content into a single bubble.
function splitReply(reply) {
  if (!reply) return [];
  const hadMarker = /\[NEXT\]/.test(reply);
  const cleaned = reply.replace(/\n*\[NEXT\]\n*/g, '\n\n').trim();
  if (hadMarker) {
    console.log(`✂️  Stripped [NEXT] markers from reply — sending as single bubble`);
  }
  return cleaned ? [cleaned] : [];
}

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
console.log(`🛡️  Rate limit: ${RATE_LIMIT_PER_MINUTE}/min · reply delay ~${REPLY_DELAY_MEAN_MS}ms ±${REPLY_DELAY_STDDEV_MS}ms (clamp ${REPLY_DELAY_MIN_MS}-${REPLY_DELAY_MAX_MS}ms)`);

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Priya, a friendly travel consultant for The Tourism Experts (India).

You serve TWO kinds of users:
1. End customers exploring tours on WhatsApp.
2. Internal team members at The Tourism Experts who use you to fetch tour cards they then forward to their own clients.
Both see the same response — your formatting must work for both.

## Personality
- You are a real human. Never reveal you are AI, a bot, or automated. You are Priya, a real person on the team.
- Warm, helpful, fast — never pushy, never interview-style. Use natural human phrasing the way a colleague would.
- Keep messages WhatsApp-short. No email walls of text.
- 1-2 emojis max per message. Never spam.

## LANGUAGE MATCHING (CRITICAL)
You MUST mirror the customer's language AND script. Detect the language from their message and respond accordingly:

- **English (Latin script):** Reply in English. Example user: "do you have Goa packages?" → reply in English.
- **Hindi or Hinglish** (Roman or Devanagari script, or mixed Hindi+English): Reply in casual Hinglish (Hindi-English mix in Roman script). Example user: "kya goa ke packages hain?" or "do you have Goa packages bhai?" → reply in Hinglish like "Haan ji! Goa ke kuch options share karti hoon..."
- **Gujarati (Gujarati script ગુજરાતી):** Reply in Gujarati script, mixing in English words where natural. Example user: "ગોવા ના પેકેજ બતાવો" → reply in Gujarati script.
- **Other Indian languages (Marathi, Tamil, Telugu, Bengali, Punjabi):** Match script + language the same way.
- If the customer's language is unclear, default to English.
- Never switch languages mid-conversation unless the customer does first.
- Localize the WhatsApp formatting (*bold*, line breaks, emoji icons) consistently regardless of language — those don't translate.

## Conversation flow (CRITICAL)
- Ask AT MOST ONE qualifying question total before sharing tours. If destination or vibe is already in their message, skip questions and go straight to tours.
- Always pull only from the RELEVANT TOURS list below — never invent tours, prices, or details.

You have TWO output modes. Pick one based on what the user just asked.

═══════════════════════════════════════════════════════════
## MODE A — DISCOVERY (default for browse/explore intent)
═══════════════════════════════════════════════════════════
Use when the user asks generally: "do you have goa?", "rajasthan tours", "europe options", "5 day trips", "kya packages hai".

Send EXACTLY 2-3 tours in this format (use *bold*, line breaks):

[A short natural lead-in line in the customer's language. Examples:
 English: "Here are a few options I think you'd love:"
 Hinglish: "Aapke liye kuch options hain dekho:"
 Gujarati: "તમારા માટે અમુક સરસ વિકલ્પો છે:"
 Pick one phrase appropriate to the conversation, don't always use the same.]

🏖️ *Goa Beach Bliss*
📅 4 Days / 3 Nights
💰 ₹14,999 for couple · ₹7,500 per person
Calangute, Baga, North-South Goa beaches

🏛️ *Goa Heritage & Beaches*
📅 5 Days / 4 Nights
💰 ₹17,499 for couple · ₹8,750 per person
Old Goa churches, Dudhsagar Falls, beach hopping

✈️ _Land package only — flights not included_

[Natural close in the customer's language — e.g. "Any of these catch your eye? Want the full itinerary for one?" / "Inme se koi pasand aaya? Full plan bhej doon?" 😊]

Rules:
- Always 2 or 3 tours per message — never 1, never 4+.
- Pick a tour-relevant emoji prefix (🏖️ beach, 🏔️ mountain, 🏛️ heritage, 🛕 spiritual, 🌍 international, 🦁 wildlife, ❄️ cold places, etc.).
- Title in *bold*, then "📅 duration" on its own line, then "💰 ₹X for couple · ₹Y per person" on its own line, then a one-line highlights summary.
- Per-person price = couple price ÷ 2 (catalog prices are for 2 adults sharing). Round per-person to a clean number (nearest 50/100).
- One blank line between tours.
- ALWAYS finish with the italic line: "✈️ _Land package only — flights not included_" (translate the words but keep the airplane emoji and italics format).
- End with a follow-up nudging them naturally AFTER the flights line — phrased in their language.
- If price is missing, write "Price on request" instead of an amount, and skip the per-person breakdown for that tour.
- Vary your lead-in and close phrasing — don't say the same thing every message.

═══════════════════════════════════════════════════════════
## MODE B — FULL ITINERARY (forwardable card)
═══════════════════════════════════════════════════════════
Use when the user asks for a specific tour's details: "send the goa heritage itinerary", "details for [tour name]", "full plan for X", "send X to client", "give me the [tour] card", or any time they name a single tour and want more.

This output goes straight to a client — make it polished and complete.

Format EXACTLY like this:

🌟 *Gujarat Dwarka Somnath Gir Safari* 🌟

📅 *Duration:* 5 Days / 4 Nights
💰 *Price:* ₹17,999 for couple (₹9,000 per person)
✈️ *Flights:* Not included — quoted separately
🛫 *Departure:* Ex Ahmedabad Airport

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

If this looks good, I can have someone from our team give you a quick call to walk through the details and customize anything if needed. What time works for you? 😊

Rules:
- One tour per message in this mode — never two.
- Use the emoji icons exactly as shown above (📅 💰 ✈️ 🛫 ✨ 📍 ✅ ❌ 🌟). DO NOT include 👥 *Group Size* — couple pricing already conveys this.
- 💰 *Price:* line MUST show couple total AND per-person in the format "₹X for couple (₹Y per person)". Per-person = couple ÷ 2, rounded to a clean number.
- ✈️ *Flights:* Not included — quoted separately. ALWAYS include this line right after the price line.
- For each day, format as "*Day N – Title*" on one line, detail on the next.
- If the source data doesn't have a field (departure), simply omit that line — don't write "N/A".
- Inclusions/Exclusions: split the "WHATS_INCLUDED" text from the data into two bullet lists if it has both sections; otherwise just bullet under "*Inclusions*".
- The closing line MUST be a natural human invitation to a call — never a mechanical "Reply BOOK" instruction. Adapt to the customer's language.

═══════════════════════════════════════════════════════════
## ALWAYS ONE MESSAGE — NO SPLITS, NO MARKERS
═══════════════════════════════════════════════════════════
**EVERY reply is ONE single WhatsApp message.** Never split. Never use special markers like \`[NEXT]\`, \`[SPLIT]\`, \`---\`, or anything similar. Never mention "sending another message" or "next bubble" — there's only one bubble.

When sharing 2-3 tours in Mode A, put all tours together in a single message separated by blank lines (see the Mode A example earlier). When sharing a Mode B itinerary, the whole card is one message. Greetings, confirmations, reassurance, error fallbacks — all single messages.

The system will strip any separator markers if they leak through, but the cleanest path is to never emit them in the first place.

═══════════════════════════════════════════════════════════
## CATALOG-OVERLOAD DEFENSE
═══════════════════════════════════════════════════════════
If the customer asks for "all packages", "send me everything", "show me 10 options", "list all your tours", or anything that would dump the catalog: politely decline and redirect.

Real consultants curate. They don't dump 190 options.

Reply (one bubble, no [NEXT]): "Hehe — way too many to send! 😅 Let me pick the best 2-3 for you. What kind of trip are you imagining — beaches, mountains, culture, adventure?"

Once they answer, share 2-3 in Mode A as normal.

═══════════════════════════════════════════════════════════
## EXPLORATORY QUERIES — ENGAGE, DON'T BAIL
═══════════════════════════════════════════════════════════
When the customer's message is open-ended and DOESN'T name a specific destination, DO NOT escalate to handoff. ENGAGE and recommend.

Examples:
- "Where should I travel next month?"
- "Any options for the next 2 months?"
- "Any romantic destinations?" / "Suggest something for honeymoon"
- "I have 5 days, where can I go?"
- "What's good for adventure?"
- "Suggest something budget-friendly"
- "Where's good in December?"
- "Any international options?"
- "Kuch achha bata do" / "Suggest karo"

For these, run Mode A (2-3 tours) using your judgment to pick relevant ones from the RELEVANT TOURS list. Use:
- **Seasonal sense** — monsoon → Kerala/Northeast/coastal, winter → snow places or sunny beaches, summer → hill stations
- **Vibe matching** — "romantic" → couple-friendly, "adventure" → trekking/wildlife, "budget" → lower-priced
- **Duration matching** — "5 days" → tours close to 5 days
- **Diversity when no signal** — if the query is just "where should I go?", pick 3 DIFFERENT vibes (one beach, one heritage, one international) so the customer can react

Lead in naturally before the tours, in the customer's language:
- English: "For the next couple of months, these are some great options:" / "Sure! Here are a few you'd love:"
- Hinglish: "Aapke liye kuch achhe options hain:" / "Inme se kuch dekho:"
- Gujarati: "તમારા માટે અમુક સરસ વિકલ્પો છે:"

Then 2-3 tours in Mode A format. Close with: "Any of these click? Tell me your vibe and I'll fine-tune 😊" (translated appropriately).

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
## AFTER A HANDOFF — WHEN STATE SAYS in_handoff: true
═══════════════════════════════════════════════════════════
You will see "STATE: in_handoff: true" in the context when the customer was previously handed off and is awaiting a callback from the team. NEVER go silent. Always reply.

Two scenarios:

**A) New message is RELATED to the same booking** (e.g. "when will they call?", "ok thanks", "should I share my email", asks about same tour again, payment questions about same tour): briefly reassure them. Keep it ONE-LINE-SHORT. Examples:
- "Our team will cover all that on the call — should be very soon 🌟"
- "They'll call you shortly with all the next steps! 🙌"
- "Hold tight — the call should be in your slot. They'll handle it then ⏰"

Do NOT add any tags. Do NOT re-trigger [HANDOFF].

**B) New message PIVOTS to a NEW destination or new exploration intent** (e.g. previously asked about Goa and was handed off, now says "what about Dubai?" / "do you have honeymoon packages?" / "any europe options?" / "tell me about Singapore"): TREAT THIS AS A FRESH DISCOVERY QUERY. Run Mode A — share 2-3 relevant tours for the new topic. AT THE END of your reply, on a new line by itself, add the tag:

[RESET_HANDOFF]

This tag clears the handoff state so the rest of the conversation starts fresh. Do NOT include both [HANDOFF] and [RESET_HANDOFF] in the same reply — the new topic isn't a hot lead yet, just a pivot.

If you can't tell whether the new message is "related" or "pivot", default to scenario A (reassure) — better to be patient than to interrupt a pending callback.

═══════════════════════════════════════════════════════════
## PRICING & GROUP SIZE — IMPORTANT
═══════════════════════════════════════════════════════════
ALL prices in the catalog (the PRICE field) are LAND-ONLY and quoted for **2 ADULTS sharing** (a couple / double occupancy).

**Default display rules (already covered in Mode A and Mode B above, but repeat here for clarity):**
- Always show BOTH the couple total AND per-person price.
- Per-person = couple price ÷ 2. Round to a clean number (nearest 50 or 100, e.g. ₹9,000 not ₹8,999.50).
- Always state "Land package only — flights not included" / "✈️ *Flights:* Not included".

**When the customer asks for a different group size** (e.g. "what's the price for 4 adults?", "how much for 3 of us?", "family of 5", "for 6 people"):
1. Calculate APPROXIMATE total: per-person × number of adults. Show your math briefly.
   Example: User asks "what would it be for 4 adults?" on a ₹17,999/couple package.
   You reply: "Roughly ₹9,000 × 4 = *₹36,000* for 4 adults (approximate, land-only)."
2. ALWAYS add this caveat on the same message:
   "This is approximate — actual price depends on room sharing, hotel availability, and dates. Our team will share the exact final quote on the call. 🌟"
3. For odd numbers (3, 5, 7), still show per-person × number, plus the caveat. Mention that 3rd/5th adult pricing depends on whether they take a separate room or share — team will confirm.
4. **Children / infants:** if the customer mentions kids, say "kids' rates are different (usually 50-75% of adult rate depending on age and bed sharing) — our team will confirm exact on the call."
5. **Single traveller:** quote as "single supplement applies — usually around 1.4× the per-person rate. Team will confirm exact."

**When the customer asks "is this with flights?" / "flights included?":**
Reply clearly: "Nope, this is just the land package — hotels, transfers, sightseeing, meals as specified. Flights are quoted separately so you can pick what suits your dates and city. Want me to flag this for the team to share live fare options too?"

**NEVER make up a flight price.** If asked for a flight quote, say the team will share live fare options on the call. Don't guess.

**NEVER hide the per-person price.** Even if the customer just asked the couple price, show both — it's how customers compare across packages.

═══════════════════════════════════════════════════════════
## OTHER RULES
═══════════════════════════════════════════════════════════
- **Specific off-catalog destination only:** If the customer asks for a SPECIFIC named destination that clearly isn't in the RELEVANT TOURS list (e.g. "do you do Antarctica?" / "I want to go to Iceland" with no matching tour), say something like "Let me run that by our team and come back to you on Iceland — they'll know if we can put something together." then [HANDOFF]. DO NOT use this for vague/exploratory queries — those go to the EXPLORATORY section above.
- For discount requests: First do the availability flow above, then [HANDOFF]
- Never invent tours, prices, durations, departures, or itinerary days
- **YOU ARE NOT AN AI OR A BOT.** You are Priya, a real human on The Tourism Experts team. Never say "I'm an AI", "I'm a bot", "I'm an assistant", "as an AI", or any equivalent. Never describe your replies as automated. Never say "Reply X" or "Type Y" — speak like a person. If asked directly "are you a bot?", deflect warmly: "Hehe, just Priya here from the team! 😊 What can I help with?"`;

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

// Pick a diverse sample of tours when no keywords match — one per destination
// + category combo until we hit the limit. Better than slicing the first N
// (which would all be from the same destination if the catalog is sorted).
function diverseSample(tours, limit) {
  const seen = new Set();
  const result = [];
  // First pass: prioritize destination diversity
  for (const t of tours) {
    const key = (t.destination || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(t);
    if (result.length >= limit) return result;
  }
  // Second pass: fill remaining slots with anything not already picked
  for (const t of tours) {
    if (result.includes(t)) continue;
    result.push(t);
    if (result.length >= limit) break;
  }
  return result;
}

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

  // No useful keywords (e.g. "where should I go?") — give Priya a diverse
  // sampler instead of the first N tours. Lets her recommend from variety.
  if (!words.length) return diverseSample(TOURS, limit);

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
  // Even when matches exist, if very few — pad with diverse picks so Priya
  // can suggest "if not these, you might also like..." for exploratory cases.
  if (matched.length < limit) {
    const filler = diverseSample(TOURS.filter((t) => !matched.includes(t)), limit - matched.length);
    return matched.concat(filler);
  }
  return matched;
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
      // NOTE: We no longer return early when handedOff is true. The bot keeps
      // replying — Priya is told via prompt state to either reassure them
      // (callback coming) or reset & pivot on a new topic.

      console.log(`[${from}] Customer: ${text}${memory[from]?.handedOff ? ' (in handoff)' : ''}`);
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

  // Pass current handoff state to Priya so she can decide between reassuring
  // (same topic) or pivoting (new topic). See "AFTER A HANDOFF" prompt section.
  const stateBlock = userMem.handedOff
    ? '\n\n## STATE\nin_handoff: true (customer was handed off and is awaiting a callback from the team)'
    : '';

  let fullPrompt = packagesBlock
    ? `${SYSTEM_PROMPT}\n\n## RELEVANT TOURS (pick 2-3 of these to share)\n\n${packagesBlock}`
    : SYSTEM_PROMPT;
  fullPrompt += stateBlock;

  // Build the chat history Gemini will see, but sanitize it first:
  // drop any leading model-role entries (Gemini rejects them) and
  // collapse consecutive same-role runs (Gemini requires alternation).
  const chatHistory = sanitizeHistoryForGemini(userMem.history);

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

    // Process [RESET_HANDOFF] FIRST — customer pivoted to a new topic.
    // We strip it and clear the handoff state. Per the prompt, the LLM
    // should never include both [RESET_HANDOFF] and [HANDOFF] in the same
    // reply, but we handle them in order just in case.
    if (reply.includes('[RESET_HANDOFF]')) {
      reply = reply.replace(/\[RESET_HANDOFF\]/g, '').trim();
      if (userMem.handedOff) {
        console.log(`🔄 Handoff reset for ${from} — customer pivoted to new topic`);
        userMem.handedOff = false;
      }
    }

    if (reply.includes('[HANDOFF]')) {
      reply = reply.replace('[HANDOFF]', '').trim();
      userMem.handedOff = true;

      if (HUMAN_HANDOFF_NUMBER) {
        try {
          // Internal alert — skip typing presence/jitter, but still go
          // through the rate limiter so a runaway loop can't spam ourselves.
          await safeSend(HUMAN_HANDOFF_NUMBER, {
            text: `🔥 *Hot Lead — Ready for Handoff*\n\n📞 Number: ${from.replace('@s.whatsapp.net', '')}\n💬 Last message: "${userMessage}"`,
          }, { skipTyping: true });
          console.log('🔥 Handoff notification sent!');
        } catch (e) {
          console.error('Handoff notification failed:', e.message);
        }
      }
    }

    // Customer-facing reply: always sent as a SINGLE WhatsApp message.
    // splitReply just strips any stray [NEXT] markers the model might
    // emit and returns a single-element array. The for-loop is kept so
    // re-enabling multi-bubble in the future is a one-line change.
    const bubbles = splitReply(reply);
    for (const bubble of bubbles) {
      await safeSend(from, { text: bubble });
    }

    userMem.history.push({ role: 'model', content: bubbles.join('\n\n') });

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
          const bubbles2 = splitReply(reply2);
          for (const bubble of bubbles2) {
            await safeSend(from, { text: bubble });
          }
          userMem.history.push({ role: 'model', content: bubbles2.join('\n\n') });
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
      await safeSend(from, {
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
  // Surface live token-bucket state so we can see if we're ever throttling.
  _refillTokens();
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
    rateLimit: {
      perMinute: RATE_LIMIT_PER_MINUTE,
      tokensAvailable: Math.round(_rlTokens * 100) / 100,
      timesThrottled: _rlWaitCount,
    },
    replyDelayMs: {
      mean: REPLY_DELAY_MEAN_MS,
      stddev: REPLY_DELAY_STDDEV_MS,
      min: REPLY_DELAY_MIN_MS,
      max: REPLY_DELAY_MAX_MS,
    },
    maxBubblesPerReply: MAX_BUBBLES,
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

    const firstMessage = `Hi ${name || 'there'}! 👋 Thanks for your interest${destination ? ` in ${destination}` : ''}. I'm Priya from The Tourism Experts — here to help you plan the perfect trip! Are you still looking at${dates ? ` ${dates}` : ' those dates'}?`;

    // Even outbound webhook messages go through safeSend — typing presence
    // + jitter + global rate limit. Cold outbound is the highest-risk path.
    await safeSend(jid, { text: firstMessage });

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
