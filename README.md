# Priya — WhatsApp AI Travel Agent

WhatsApp bot for **The Tourism Experts** that answers customer queries, shares 2-3 relevant tours from a 190-tour catalog, generates forwardable full-itinerary cards for internal staff, and routes hot leads to a human team.

**Live:** [travel-bot-production-0570.up.railway.app](https://travel-bot-production-0570.up.railway.app/)
**Status JSON:** [/status](https://travel-bot-production-0570.up.railway.app/status)

---

## 📖 For everything about this project — read [PROJECT.md](./PROJECT.md)

That single file covers:
- What Priya does and how she replies (Mode A discovery vs Mode B full-itinerary)
- Architecture diagram + file structure
- All environment variables
- The hot-lead callback flow
- Memory & persistence layout
- All known failure modes (with fixes)
- Decisions log (the "why")
- Roadmap items not yet built
- How to resume / hand off the project

If you're an AI assistant being asked to help with this bot, paste `PROJECT.md` into context first.

---

## Quick start (for a fresh dev)

```bash
git clone https://github.com/hiraniavnish-droid/travel-bot.git
cd travel-bot
npm install
# Set GEMINI_KEY and HUMAN_HANDOFF_NUMBER in your env
node bot.js
# Open http://localhost:3000/qr in a browser, scan with WhatsApp → Linked Devices
```

## Tech stack
Node.js 20 · Express · [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web protocol) · [@google/generative-ai](https://www.npmjs.com/package/@google/generative-ai) · deployed on Railway.

## License
Private project. All tour data property of The Tourism Experts.
