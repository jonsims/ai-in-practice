# AI Activity Log — ai-in-practice

## 2026-04-15 — Initial build + deploy

**Files reviewed:** server.js, public/submit.html, public/display.html, public/admin.html, package.json, render.yaml, CLAUDE.md

**Files created/updated:**
- `server.js` — complete rewrite from collective-question fork; new data model (roles/arcs/teaches/wishes/questions), 4 synthesis endpoints (portrait, frontier, clusters, invitation), realistic test data for faculty/admin audience
- `public/submit.html` — new form: 2 tap pickers + 3 short text inputs, 60–90s mobile target
- `public/display.html` — 9 display states mapped to the Tool→Colleague arc; dropped globe/map/recipe
- `public/admin.html` — solo-presenter layout, acts grouped 0→4, prediction bar, per-item delete for teaches/wishes
- `package.json` — renamed, dropped globe.gl/three deps
- `render.yaml` — renamed service to ai-in-practice
- `CLAUDE.md` — full rewrite documenting the new architecture

**Deleted from fork parent:** locations.js, globe.gl.min.js, earth-day.jpg, earth-night.jpg, Quick Start Guide.md, testing guide.md, AI_LOG.md (parent's)

**Key decisions:**
- Forked as sibling directory, not branch — apps diverge completely
- Five questions designed for 60-second mobile completion (two taps + three one-liners)
- Each act maps to a stage of the deck's central arc: Act 0 (Chatbot/data), Act 1 (Assistant/portrait), Act 2 (Agent/frontier), Act 3 (meta-question), Act 4 (Colleague/invitation)
- Portrait prompt explicitly forbids jargon (LLM, RAG, agentic, tokens, etc.) since audience includes newcomers
- Portrait expanded from 1 sentence/frame to 2-3 sentences at 1.25rem to help newbies follow

**Deployment:**
- GitHub: github.com/jonsims/ai-in-practice (master, auto-deploy on commit)
- Render: new web service `ai-in-practice` on Starter plan, wired manually via dashboard
- Env vars: ANTHROPIC_API_KEY + ADMIN_PIN set on Render

**Smoke test results:**
- All 4 synthesis endpoints produce clean JSON with strong content quality
- Portrait closing line sample: "This room already knows that the hardest part of most work is figuring out what you actually mean — and nearly every trick you submitted was quietly about that."
- Submit + admin + display pages all return 200
- Test data loads clean: 43 roles, 43 arcs, 36 teaches, 28 wishes, 46 questions

**Known notes for event day:**
1. Portrait may run slightly long on 720p projectors — check in admin preview, re-generate if needed
2. Synthesis needs ≥5 teaches / ≥3 wishes / ≥5 questions; use Load Test Data as fallback for small audiences
3. Prediction input in admin is a local scratch pad (not persisted)

**Recommended next actions:**
- Manual dress rehearsal: click through all 9 display states with test data on actual projector
- If reusing for future events: consider adding Playwright smoke test for submit form
- If deploying to NAS later: standard Docker flow via deploy-to-nas skill
