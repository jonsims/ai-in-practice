# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A live event app for the "Exploring AI in Practice" session at Babson College — an AI talk for a mixed university audience of students, faculty, staff, administrators, and industry guests. Jonathan presents solo (~30–40 min).

The app is the demonstration: it walks the audience live through the talk's central arc — **Chatbot → Assistant → Agent → Colleague** — by running each stage as a live act on the audience's own submissions.

Forked from `collective-question` (Launch Babson admitted student day). Shares the engine; questions and synthesis are totally different.

## Commands

```bash
npm start          # Run server (port 3000)
npm run dev        # Run with --watch for auto-reload
```

## Deployment

- **Local:** http://localhost:3000 — also accessible at `https://local.ai-in-practice` via Caddy (run `/add-local-site` skill to register).
- **Production (Render):** Deploy as its own service `ai-in-practice` (separate from `collective-question`).
- **Backup tunnel:** `cloudflared tunnel --url http://localhost:3000 --no-autoupdate`

## Environment

Requires `.env` with: `ANTHROPIC_API_KEY`, `ADMIN_PIN` (default: 1234), `PORT` (default: 3000).

## Architecture

**Single-file Express server** (`server.js`) with all state in memory. No database — data resets on restart.

**Three pages served as static HTML from `public/`:**
- `submit.html` — mobile-first form, 60–90 second completion target. Two tap pickers (role, arc position) + three short text inputs (teach, wish, question). Hard char caps: 80 / 100 / 200.
- `admin.html` — PIN-protected control panel. Buttons grouped by Act (0→4). Solo-presenter format: single prediction box per act. Includes readiness indicators, synthesis results preview, delete-per-item for teaches/wishes/questions.
- `display.html` — full-screen projector view with 9 states, polls `/api/state` every 2 seconds.

**Valid display states (9):** `collection`, `role_chart`, `arc_chart`, `portrait`, `frontier`, `clusters`, `meta_question`, `outlier`, `invitation`.

**Data model (5 input fields):**
- `roles` — validated against `VALID_ROLES` (Undergrad, Grad student, Faculty, Staff, Administrator, Industry guest)
- `arcs` — validated against `VALID_ARCS` (Chatbot, Assistant, Agent, Colleague)
- `teaches` — free text ≤80 chars ("one AI trick you'd teach a colleague")
- `wishes` — free text ≤100 chars ("one thing you wish AI could do but can't yet")
- `questions` — free text ≤200 chars (hardest question about AI)

## The Five Acts

Each maps to a stage of the Tool→Colleague arc and a display state.

### Act 0 — "Who's in the room" (Chatbot stage)
Pure data, no AI. Two charts back-to-back: `role_chart` then `arc_chart`. Predict #1 before reveal.

### Act 1 — "Portrait of your practice" (Assistant stage)
AI synthesizes the `teaches` into a Time / Effort / Skill portrait of the room (2-3 plain-English sentences per frame, explicitly no jargon — prompt forbids "LLM," "agentic," "tokens," etc.) + a closing line. Runs at 900 max_tokens. Endpoint: `/api/admin/synthesize/portrait`.

### Act 2 — "The Frontier" (Agent stage)
AI picks 3 of the most interesting `wishes` and proposes specific agentic workflows that could do them today — naming real tools (Claude Code, MCP servers, NotebookLM, etc.), 3 steps each, with caveats. Endpoint: `/api/admin/synthesize/frontier`.

### Act 3 — "The Meta Question"
Clusters all `questions`, picks one meta-question, surfaces one outlier. Answered unrehearsed. Endpoint: `/api/admin/synthesize/clusters`.

### Act 4 — "The Invitation" (Colleague stage)
AI looks across everything submitted and proposes 2–3 new AI use cases this specific room hasn't mentioned but would clearly benefit from. Warm, colleague-like tone. Closes with a personalized "pick one tool, one task, one colleague" call. Endpoint: `/api/admin/synthesize/invitation`.

## AI synthesis details

- Model: `claude-sonnet-4-6`
- 30s timeout via `Promise.race`
- JSON parsing: 3-strategy fallback (direct → strip fences → regex extract)
- Admin "Generate All" runs all 4 acts in parallel via `Promise.allSettled`

## Key patterns (preserved from fork)

- Admin auth: PIN via `x-admin-pin` header. No session/JWT.
- Display coordination: admin sets `displayState` via POST, display page picks it up on next poll (2s).
- Between-session reset: `POST /api/admin/next-session` with `{ confirm: true }`.
- Live preview: admin embeds `/display` in a scaled iframe.
- Polling loops have in-flight guards (`pollInFlight`, `refreshInFlight`).
- All fetch calls have AbortController timeouts (5s display, 8s admin, 10s submit).
- Input caps enforced server-side too.

## Key Constraints

- Solo presenter, ~30–40 minute session.
- Display text readable from 50+ feet — minimum 1.5rem for supporting text.
- Must work on flaky Wi-Fi. No external CDN dependencies. QR code generated locally.
- Audience submits in 60–90 seconds on their phones. Keep form minimal and tap-friendly.
- Admin operates under pressure mid-presentation. Controls are grouped by Act; destructive actions in a "Danger Zone".

## Files

```
server.js                  — Express server, all routes, synthesis logic, test data
public/submit.html         — Audience submission form (mobile, 5 questions)
public/admin.html          — Presenter control panel
public/display.html        — Projector display (9 states, full-screen)
render.yaml                — Render deployment blueprint
.env                       — API key + PIN (gitignored)
```

## What changed from the fork parent

- Dropped: `locations.js`, globe.gl library, earth textures, recipe act, world map states, career/location/talent/food fields.
- Added: role + arc whitelists, `frontier` + `invitation` synthesis endpoints, prediction bar in admin, per-item delete for teaches + wishes.
- Renamed: all session fields; all display states; all synthesis endpoints.
