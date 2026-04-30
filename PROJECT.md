# Priya — WhatsApp AI Travel Agent for The Tourism Experts

> Master project doc. Everything you need to resume, debug, train, or hand off this bot lives here.

---

## 1. What This Is

A WhatsApp bot that acts as **Priya**, a friendly travel consultant for **The Tourism Experts** (India). It connects to WhatsApp through a linked-device QR scan (no Meta Business API needed), uses **Google Gemini** for replies, has a 190-tour catalog with full itineraries, and routes hot leads to a human number.

It serves two audiences:
- **End customers** browsing tours and asking for details on WhatsApp.
- **Internal staff** at The Tourism Experts who message Priya to get polished, forwardable tour cards they then send to their own clients.

---

## 2. Quick Reference

| Thing | Value |
|---|---|
| Live URL | `https://travel-bot-production-0570.up.railway.app/` |
| QR scan page | `/qr` |
| Status / diagnostics | `/status` |
| Reset (re-link WhatsApp) | `/reset` |
| GitHub repo | `https://github.com/hiraniavnish-droid/travel-bot` |
| Hosting | Railway project `jubilant-rejoicing` |
| Auto-deploy | Yes — every push to `main` |
| Tech stack | Node.js 20, Express, Baileys, Google Generative AI |

---

## 3. What Priya Does — Behavior Map

### Mode A — Discovery (default for browse intent)
**Triggers:** "do you have goa?", "rajasthan tours", "europe options", "5 day adventure", general browsing.
**Output:** 2-3 tours with destination-specific emojis, formatted for WhatsApp:
```
✨ Here are some options for you:

🏖️ *Goa Beach Bliss*
📅 4 Days / 3 Nights · 💰 ₹14,999
Calangute, Baga, North-South Goa beaches

🏛️ *Goa Heritage & Beaches*
📅 5 Days / 4 Nights · 💰 ₹17,499
Old Goa churches, Dudhsagar Falls, beach hopping

Want the full itinerary for any of these? 😊
```

### Mode B — Full Itinerary (forwardable card)
**Triggers:** "send the goa heritage itinerary", "full plan for X", "give me the [tour] card", or any time the user asks for full details on a single tour.
**Output:** One polished card with day-by-day itinerary, inclusions/exclusions, and a "Reply BOOK" call-to-action. Designed for internal staff to copy-paste straight to their clients.

### Hot Lead → Callback Flow
When Priya detects buying intent (book intent, payment Q, dates+travellers confirmed, "let's proceed", "yes I want this"):
1. **First reply:** "Awesome choice! 🙌 What time works best for our travel expert to call you — today or tomorrow?" (no handoff yet)
2. Customer shares time (e.g. "around 4pm")
3. **Second reply:** "Got it! Our team will call you at 4pm. Sit tight 🌟" + `[HANDOFF]` tag fires → your `HUMAN_HANDOFF_NUMBER` gets the alert.

### After Handoff — Reply Behavior
Bot keeps replying. Two scenarios:
- **Same topic** ("when will they call?"): one-line reassurance, no tags.
- **New topic** ("what about Dubai?"): runs Mode A discovery for the new destination + emits `[RESET_HANDOFF]` to clear state.

---

## 4. Architecture

```
┌─────────────────────┐
│   Customer/Staff    │
│   on WhatsApp       │
└──────────┬──────────┘
           │ message
           ▼
┌─────────────────────┐         ┌──────────────────┐
│   Baileys           │ ◄─────► │  WhatsApp        │
│  (linked device)    │         │  servers         │
└──────────┬──────────┘         └──────────────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│  bot.js (Node 20 + Express on Railway)     │
│  ┌─────────────────────────────────────┐   │
│  │ Memory:                              │   │
│  │ - in-RAM `memory[jid]`               │   │
│  │ - persisted to `auth_session/        │   │
│  │   conversations/<jid>.json`          │   │
│  └─────────────────────────────────────┘   │
│                                              │
│  ┌─────────────────────────────────────┐   │
│  │ Tours catalog:                       │   │
│  │ - bundled `tours.json` (190 tours)   │   │
│  │ - keyword filter → top 6 per call    │   │
│  └─────────────────────────────────────┘   │
└──────────────────────┬──────────────────────┘
                       │ prompt + history + tours
                       ▼
              ┌─────────────────┐
              │  Google Gemini  │
              │  (2.5-flash)    │
              └────────┬────────┘
                       │ reply text
                       ▼
                 [HANDOFF tag?]
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
   send to customer       alert HUMAN_HANDOFF_NUMBER
```

---

## 5. File Structure

```
travel-bot/
├── bot.js              # Main bot (Express + Baileys + Gemini)
├── tours.json          # 190-tour catalog (generated from CSV)
├── package.json        # Deps + Node 20 engine pin
├── .gitignore
└── PROJECT.md          # This file
```

**Why everything is in `bot.js`:** intentionally a single-file Node app so a non-developer can read the whole thing top-to-bottom. ~750 lines.

---

## 6. Environment Variables (Railway → Variables)

| Var | Purpose | Default | Required? |
|---|---|---|---|
| `GEMINI_KEY` | Google AI Studio API key (label: "wsap bot") | — | **Yes** |
| `HUMAN_HANDOFF_NUMBER` | Where hot-lead alerts go (format: `91xxxxxxxxxx@s.whatsapp.net`) | — | **Yes** for handoff |
| `GEMINI_MODEL` | Override Gemini model name | `gemini-2.5-flash` | No |
| `HISTORY_LIMIT` | Messages remembered per customer | `40` | No |
| `PORT` | HTTP port | `3000` (Railway sets `8080`) | No (Railway provides) |
| `PACKAGES_CSV_URL` | **DEPRECATED** — bot now uses bundled `tours.json` | — | No |

---

## 7. The Tour Catalog (`tours.json`)

Each tour entry:
```json
{
  "title": "Gujarat Dwarka Somnath Gir Safari",
  "destination": "Gujarat",
  "destinations": "Gujarat",
  "categories": "All",
  "duration": "5 Days / 4 Nights",
  "price": "17999 INR",
  "departure": "Ex Ahmedabad Airport",
  "group_size": "2 Adults",
  "overview": "Combine Gujarat's spiritual heritage...",
  "highlights": ["Dwarkadhish Temple...", "..."],
  "itinerary": [
    { "title": "Day 1: Ahmedabad to Dwarka", "detail": "..." },
    { "title": "Day 2: ...", "detail": "..." }
  ],
  "whats_included": "Inclusions\n• ...\nExclusions\n• ..."
}
```

### How to update tours
**Option A — Edit JSON directly on GitHub:**
1. Open `tours.json` in the GitHub UI → edit → commit. Railway auto-redeploys.

**Option B — Re-import from a CSV:**
1. Export your sheet to CSV with the same columns the original `Tours.csv` had (Title, Destinations, Destination, Categories, Trip Overview, Trip Highlights, Itinerary Title 1-8, Itinerary Subtext 1-8, What's Included, Duration, Departure, Group Size, Price:, Includes).
2. Run the conversion (Python script — see `/scripts/csv_to_json.py` if added, or recreate from this doc's history).
3. Replace `tours.json`, commit, push.

### Keyword filter
Each Gemini call only sees the **top 6 most relevant tours** (not all 190). Scoring:
- Title match: 3× weight
- Destination/category match: 1× weight
- Stopwords filtered out (`tour`, `package`, `i`, `the`, etc.)
- Pulls in last 2 user messages for richer context

If no keyword matches, falls back to first 6 tours so Priya always has something to suggest.

---

## 8. Priya's Prompt (System Prompt)

Lives at the top of `bot.js` as `SYSTEM_PROMPT`. It defines:

1. **Identity** — Priya from The Tourism Experts, serves customers + internal staff.
2. **Personality** — warm, fast, WhatsApp-short, 1-2 emojis max, Hindi-English mix when user does.
3. **Conversation flow** — at most ONE qualifying question, then share tours.
4. **Mode A (Discovery)** — exact format with emoji prefixes, 2-3 tours, bold titles, follow-up question.
5. **Mode B (Full Itinerary)** — exact forwardable card format with all emoji icons (📅 💰 🛫 👥 ✨ 📍 ✅ ❌ 📞 🌟).
6. **Hot lead callback flow** — two-step before [HANDOFF] tag.
7. **After-handoff behavior** — never silent; reassure or pivot.
8. **Tags Priya can emit:**
   - `[HANDOFF]` — escalate to human, set `handedOff = true`.
   - `[RESET_HANDOFF]` — customer pivoted to new topic, clear `handedOff`.

### Tuning the prompt
The whole behavior is text. Edit `SYSTEM_PROMPT` in `bot.js`, push, done. No retraining needed. Common tweaks:
- Change tone (more formal, more casual)
- Add language preferences ("default to Gujarati if customer uses Gujarati")
- Add new tags (e.g. `[REQUEST_DOCS]` for ID collection)
- Adjust number of tours per discovery message (currently 2-3)

---

## 9. Memory & Persistence

### In-memory state
```js
memory[jid] = {
  history: [{ role: 'user'|'model', content: '...' }, ...],  // capped at HISTORY_LIMIT
  handedOff: false,
  lastSeen: 1777545822000
}
```

### Disk layout (Railway volume — `/app/auth_session/`)
```
auth_session/
├── creds.json                    # Baileys WhatsApp auth (do not touch)
├── pre-key-*.json, sender-key-*  # Baileys signal protocol state
└── conversations/
    ├── 919xxxxxxxxxx_s_whatsapp_net.json   # one file per customer
    ├── 140728xxxxxxxxx_lid.json
    └── ...
```

### Behavior
- **Every turn writes** the customer's full state to their JSON file (atomic write: tmp → rename).
- **On startup** every JSON in `conversations/` is loaded into `memory`.
- **`/reset` preserves conversations** — only wipes Baileys auth (forcing re-scan).
- **Storage cost:** ~5-10 KB per customer. 1000 customers = ~10 MB on the 5 GB volume.

---

## 10. Diagnostic Endpoints

- **`GET /`** → "Priya bot is running ✅" (health check)
- **`GET /qr`** → QR for first WhatsApp link, or "✅ already linked" once connected
- **`GET /status`** → live JSON state:
  ```json
  {
    "hasQR": false,
    "isConnecting": false,
    "reconnectPending": false,
    "activeModel": "gemini-2.5-flash",
    "historyLimit": 40,
    "toursLoaded": 190,
    "sessionFiles": ["creds.json", "pre-key-1.json", ...],
    "activeUsers": 5,
    "persistedConversations": 12
  }
  ```
- **`GET /reset`** → wipes Baileys auth, preserves customer conversations, in-process reconnect (no Railway restart needed)
- **`POST /new-lead`** → webhook to initiate a Priya message (for website forms etc.)
  ```json
  POST /new-lead
  { "name": "Avnish", "phone": "919xxxxxxxxxx", "destination": "Goa", "dates": "next month" }
  ```

---

## 11. Iteration Workflow

The whole loop is fast:
1. Edit `bot.js` (or `tours.json`, or `PROJECT.md`) on GitHub or locally.
2. Commit + push to `main`.
3. Railway sees the push, builds, deploys (30-60 seconds).
4. Refresh `/status` to verify the new state.
5. Test on WhatsApp.

For prompt tuning, no redeploy logic to think about — it's just text in `bot.js`. For tour updates, just `tours.json`. For runtime config (`HISTORY_LIMIT`, `GEMINI_MODEL`), use Railway Variables (no code change).

---

## 12. Common Failure Modes — Already Solved

These are real bugs we hit and fixed. Listed so future-you doesn't waste time rediscovering them.

| Symptom | Cause | Fix in code |
|---|---|---|
| QR page stuck on "Waiting for QR…" | Old `/reset` did `process.exit(1)` and trusted Railway to restart cleanly. Flaky — sometimes the new container booted slower than the meta-refresh. | New `/reset` is in-process: tear down socket, wipe auth, reconnect — no exit. |
| Reconnect storm (hundreds/sec of "Connection closed") | The close handler called `connectToWhatsApp()` synchronously, no guard, no backoff. | `isConnecting` single-flight flag + 3s `reconnectTimer` debounce. |
| `EBUSY: rmdir auth_session` on reset | `auth_session/` is a Railway volume mount point — you can't rmdir a mount. | Wipe **contents** only, not the directory. |
| Process crash on socket teardown | `WebSocket was closed before connection was established` was an unhandled `error` event. | No-op listener attached to `sock.ws`, plus process-level `uncaughtException` handler. |
| `crypto is not defined` in Baileys | Baileys 6.7.9 uses `globalThis.crypto` (WebCrypto), only available as a global from Node 19+. Railway was running Node 18. | Polyfill `globalThis.crypto = require('crypto').webcrypto` at top of `bot.js`, plus `engines.node >= 20`. |
| Gemini 400 "Invalid value at 'system_instruction'" | `systemInstruction` was passed to `startChat()`. In `@google/generative-ai` 0.21.0 it belongs on `getGenerativeModel()`. | `getModel(systemInstruction)` factory used per-call. |
| Gemini 404 "model not found" / "no longer available" | Google retires Gemini models periodically. Hardcoded `gemini-1.5-flash` then `gemini-2.0-flash` both got retired. | Default `gemini-2.5-flash` + auto-fallback chain on 404. Override via `GEMINI_MODEL` env var. |
| All replies are "Sorry, I'm having a little trouble" | Often = a Gemini error. Could be: model name, packages CSV returning HTML, key invalid, rate limit. | Improved error logging (`AI error: <msg>` + stack truncated to 800 chars). HTML-response detection in `getPackages` (now removed since we use bundled tours). |
| Bot silent after handoff | `handedOff: true` made the bot ignore the customer entirely. | Removed the early return. Bot now passes `STATE: in_handoff: true` to Priya, who decides per-prompt whether to reassure or pivot. New `[RESET_HANDOFF]` tag clears state on topic pivot. |

---

## 13. Decisions Log (the "why")

- **Baileys, not Meta Business API.** No business verification needed, no template approvals, instant setup. Cost: it's a linked-device session (like WhatsApp Web), so the linked phone has to stay reachable.
- **Single-file `bot.js`.** Easier for a non-developer to read top-to-bottom and ask Claude to modify a specific section.
- **Bundled `tours.json` instead of Google Sheets fetch.** Original design fetched a published Google Sheet CSV at runtime. Real-world: the URL was fragile (publish-to-web vs editor URL), the body could be HTML, and any failure poisoned the prompt. Bundling is reliable and update-via-git is fine for ~190 tours.
- **Top-6 keyword filter, not all 190 tours per call.** ~6 KB context vs ~110 KB. Faster, cheaper, more focused. Gemini stays grounded on relevant options.
- **Two output modes (Discovery vs Full Itinerary), prompt-driven.** Gemini decides which based on the user's message. No code branching needed — just clear instructions in the prompt.
- **Two-step hot-lead handoff.** Asking for callback availability before [HANDOFF] makes customers feel held instead of dropped. Conversion-positive UX.
- **Don't silence after handoff.** Customers come back with new questions or pivot to other destinations. Going silent feels like the bot died. We pass state to Priya and let her handle gracefully.
- **Persist conversations on the Railway volume.** Conversations are user data; auth is implementation. `/reset` should wipe auth (forcing re-link) without dropping customer history.
- **Atomic JSON writes (tmp → rename).** Prevents corrupted files on crash mid-write. Worth the 1 line of complexity.
- **Process-level `uncaughtException` handler.** Baileys' WebSocket layer can throw async errors during teardown that aren't catchable from our code. Better to log and continue than die.
- **Auto-fallback Gemini model chain.** Google deprecated 1.5-flash and 2.0-flash within a year. Hardcoding one model is a ticking time bomb. The fallback list (`gemini-2.5-flash → flash-latest → 2.5-pro → pro-latest`) self-heals on the next message.

---

## 14. Roadmap (Discussed, Not Built)

Things we talked about but haven't shipped. Pick any of these to continue.

### High-leverage
- **Lead capture to Google Sheets.** Every conversation logs to a sheet (timestamp, phone, destination interest, hot-lead status, handoff time). Useful for sales pipeline tracking. Implementation: add a Google Sheets API call in `persistConversation` (or in a parallel writer) using a service account. ~1-2 hours.
- **FAQ second sheet.** A pinned set of Q&A injected into the prompt for things like "do you offer EMI?", "what's the cancellation policy?". Source from a separate Google Sheet for non-tour content. ~1 hour.
- **Multi-language detection.** Currently Priya mirrors the user's Hindi-English mix because of one prompt line. Could explicitly detect language (Hindi, Marathi, Gujarati) and respond fully in that language. ~30 mins of prompt tuning + maybe a language detector.

### Medium-leverage
- **Voice/image handling.** WhatsApp accepts voice notes and images. Could transcribe voice (Gemini supports audio input) or OCR a photo of a passport for booking. Adds material code.
- **Daily/weekly stats endpoint.** `/stats?since=2026-04-01` returning conversation counts, hot leads triggered, top destinations queried. Useful for the operator. ~1 hour.
- **Idle nudges.** If a customer is mid-conversation and goes silent for 24h, send a "still interested?" follow-up. Implementation: scheduled cron checking `lastSeen` per conversation. ~2 hours.

### Lower-leverage (caveats)
- **`syncFullHistory: true`** to read pre-existing WhatsApp history with each contact. Detailed analysis in earlier conversation: high effort, finicky, and the linked phone has to actually have the history cached. Worth it ONLY if you migrate Priya to an existing high-volume business line.
- **Web admin panel.** A small dashboard for tour CRUD, conversation viewing, prompt editing. Real engineering project — would unify the GitHub-edit workflow into a UI.
- **A/B testing prompts.** Route 50% of customers to a variant prompt, compare conversion rates. Premature until you have meaningful volume.

---

## 15. Credentials Status

| Item | Status | Action |
|---|---|---|
| GitHub PAT (`ghp_Gw77...`) | Used in chat, exposed | **ROTATE** — GitHub → Settings → Developer settings → Personal access tokens → revoke + regenerate |
| Gemini API key (label "wsap bot") | Used in env, mentioned in chat | **ROTATE** — Google AI Studio → API keys → revoke + regenerate, then update `GEMINI_KEY` in Railway Variables |
| Railway access | Personal | Keep — protect with strong password + 2FA |
| WhatsApp linked-device session | Active | Lives on the volume; survives redeploys |

---

## 16. Resuming Work — Step-by-Step

When you (or a future helper) come back to this:

1. **Read this file end-to-end.** It's the whole brain.
2. **Pull the latest code:**
   ```bash
   git clone https://github.com/hiraniavnish-droid/travel-bot.git
   cd travel-bot
   ```
3. **Check the bot is alive.** Open `https://travel-bot-production-0570.up.railway.app/status`. If it returns JSON with `toursLoaded: 190`, you're good. If 502/down, check Railway dashboard.
4. **Send a "hi" from a test WhatsApp number** to confirm Priya replies.
5. **Decide what to change.** Most common starting points:
   - Tweak Priya's tone/format → edit `SYSTEM_PROMPT` in `bot.js`
   - Add/edit/remove tours → edit `tours.json`
   - Try a new Gemini model → set `GEMINI_MODEL` in Railway Variables (no code change)
   - Build a roadmap item → see section 14
6. **For any code change:** edit on GitHub UI (or locally), commit, push. Railway auto-deploys in ~45s.
7. **Verify in Railway logs** that the new commit is running and there are no errors.
8. **Test the change on WhatsApp.**

### If you're starting a new Claude/AI session for this project
Paste the contents of this file as context. The doc is structured so an LLM can pick up the project and reason about it accurately. It captures:
- Architecture and design decisions
- File-by-file purpose
- All env vars
- All known failure modes and fixes
- Where to make different kinds of changes

---

## 17. Commit History — Annotated

The story of the bot in commits, in order:

| Commit | What | Why |
|---|---|---|
| `f1c5ad9` | Initial scaffold | Basic Baileys + Gemini + Express skeleton |
| `d3370d3` | In-process `/reset` | `process.exit(1)` was flaky on Railway |
| `06c0f35` | Reconnect storm fix | Single-flight + 3s backoff. EBUSY wipe fix. uncaughtException handler. |
| `6dcbf5d` | Latest WA version + Baileys logs | `fetchLatestBaileysVersion()` + browser fingerprint + pino warn level. Added `connection.update` JSON logging. |
| `29ca879` | Crypto polyfill + Node 20 | Fixed `crypto is not defined` from Baileys on Node 18. |
| `84fdfe9` | systemInstruction placement + HTML guard | Moved to `getGenerativeModel`, detected HTML responses from broken Sheets URL. |
| `af3c788` | Gemini 2.0-flash | First swap when 1.5-flash got retired. |
| `3536f09` | Gemini 2.5-flash + auto-fallback | After 2.0-flash also got retired. Added the fallback chain. |
| `9e77b5e` | Tighter prompt — at most 1 question | Customer feedback: bot was over-interviewing. |
| `c42e7b8` | Persistent memory + 40-msg history | Conversations now survive restarts; bigger window per customer. |
| `c10357a` | Tour catalog + keyword filter + 2-3 share format | First version of bundled `tours.json`. |
| `11d7523` | Mode B forwardable card + callback flow | Two output modes; two-step handoff. |
| `77db53e` | No silence after handoff + RESET tag | Bot keeps replying; pivots gracefully on new topics. |
| `35798ac` | Rename to The Tourism Experts | Correct company name everywhere. |

---

## 18. Glossary

- **Baileys** — Node library that speaks the WhatsApp Web protocol. Lets a server act like a linked WhatsApp Web device.
- **JID** — WhatsApp's internal user ID. Looks like `919xxxxxxxxxx@s.whatsapp.net` for individuals or `xxxxxxxxxxx@lid` for some business contacts.
- **Linked device** — When you scan a QR with WhatsApp → Linked Devices, that device gets a session that mirrors the primary phone. Limited to a few per account, time-limited if primary phone goes offline for 14+ days.
- **Hot lead** — A customer message showing buying intent. Triggers the callback-availability flow + `[HANDOFF]`.
- **Mode A / Mode B** — Discovery (browse) vs Full Itinerary (forwardable card). Decided by Priya based on user's message.
- **`[HANDOFF]` / `[RESET_HANDOFF]`** — Internal tags Priya emits in her reply that the bot strips and acts on (alert human / clear handoff state).
- **Pino** — Logging library Baileys uses internally. Set to `warn` so we see real errors but not chatter.

---

*Last updated: 2026-04-30 by Claude session (Avnish + bot bring-up).*
