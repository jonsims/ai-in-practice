require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/submit'));
app.get('/submit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'submit.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));

// ─── Whitelists ──────────────────────────────────────────────────────────────

const VALID_ROLES = ['Undergrad', 'Grad student', 'Faculty', 'Staff', 'Administrator', 'Industry guest'];
const VALID_ARCS = ['Chatbot', 'Assistant', 'Agent', 'Colleague'];
const VALID_STATES = ['collection', 'role_chart', 'arc_chart', 'portrait', 'frontier', 'clusters', 'meta_question', 'outlier', 'invitation'];

// Char caps — tight so mobile submissions finish in 60-90 seconds
const CAP_TEACH = 80;
const CAP_WISH = 100;
const CAP_QUESTION = 200;
const CAP_TOTAL_SUBMISSIONS = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseClaudeJSON(raw) {
  try { return JSON.parse(raw); } catch {}
  try {
    const stripped = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(stripped);
  } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  console.error('[PARSE FAIL] Raw response:', raw);
  throw new Error('Could not parse Claude response');
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Claude API timeout')), ms)),
  ]);
}

function synthesisErrorMessage(err) {
  const msg = err.message || '';
  if (msg.includes('timeout')) return 'Claude API timed out — try again in 30s';
  if (msg.includes('Could not parse')) return 'Response couldn\'t be parsed — retrying usually works';
  if (err.status) return `Claude API error (${err.status}) — try again in 30s`;
  return 'Unexpected error — check server logs';
}

function distribution(arr, orderHint) {
  const counts = {};
  arr.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  return Object.entries(counts)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      if (orderHint) {
        const ai = orderHint.indexOf(a[0]);
        const bi = orderHint.indexOf(b[0]);
        if (ai !== -1 && bi !== -1) return ai - bi;
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([label, count]) => ({ label, count }));
}

// ─── In-memory session state ────────────────────────────────────────────────

function makeEmptySession() {
  return {
    roles: [],
    arcs: [],
    teaches: [],
    wishes: [],
    questions: [],
    nextId: 1,
    displayState: 'collection',
    portraitResult: null,
    frontierResult: null,
    clustersResult: null,
    invitationResult: null,
    synthesizing: { portrait: false, frontier: false, clusters: false, invitation: false },
  };
}

let session = makeEmptySession();
function resetSession() { session = makeEmptySession(); }

// ─── Public API ─────────────────────────────────────────────────────────────

app.get('/api/qr', async (req, res) => {
  const url = req.query.url || `${req.protocol}://${req.get('host')}/submit`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', color: { dark: '#006341', light: '#ffffff' }, width: 300 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    res.status(500).send('QR error');
  }
});

app.get('/api/count', (req, res) => {
  res.json({ total: session.roles.length });
});

app.get('/api/enums', (req, res) => {
  res.json({ roles: VALID_ROLES, arcs: VALID_ARCS });
});

// Submit form
app.post('/api/submit', (req, res) => {
  const { role, arc, teach, wish, question } = req.body;

  if (!role || !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Please pick your role.' });
  if (!arc || !VALID_ARCS.includes(arc)) return res.status(400).json({ error: 'Please pick where you are on the arc.' });
  if (session.roles.length >= CAP_TOTAL_SUBMISSIONS) return res.status(429).json({ error: 'Submissions are closed' });

  session.roles.push(role);
  session.arcs.push(arc);

  if (teach && typeof teach === 'string') {
    const t = teach.trim().slice(0, CAP_TEACH);
    if (t) session.teaches.push(t);
  }
  if (wish && typeof wish === 'string') {
    const w = wish.trim().slice(0, CAP_WISH);
    if (w) session.wishes.push(w);
  }
  if (question && typeof question === 'string') {
    const q = question.trim().slice(0, CAP_QUESTION);
    if (q) session.questions.push({ id: session.nextId++, text: q, timestamp: Date.now() });
  }

  res.json({ ok: true });
});

// Public polling endpoint
app.get('/api/state', (req, res) => {
  res.json({
    displayState: session.displayState,
    count: {
      roles: session.roles.length,
      arcs: session.arcs.length,
      teaches: session.teaches.length,
      wishes: session.wishes.length,
      questions: session.questions.length,
    },
    roleDistribution: distribution(session.roles, VALID_ROLES),
    arcDistribution: distribution(session.arcs, VALID_ARCS),
    questions: session.questions,
    portraitResult: session.portraitResult,
    frontierResult: session.frontierResult,
    clustersResult: session.clustersResult,
    invitationResult: session.invitationResult,
    synthesizing: session.synthesizing,
  });
});

// ─── Admin API ───────────────────────────────────────────────────────────────

function checkPin(req, res) {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/data', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json({
    roles: session.roles,
    arcs: session.arcs,
    teaches: session.teaches,
    wishes: session.wishes,
    questions: session.questions,
    roleDistribution: distribution(session.roles, VALID_ROLES),
    arcDistribution: distribution(session.arcs, VALID_ARCS),
    displayState: session.displayState,
    portraitResult: session.portraitResult,
    frontierResult: session.frontierResult,
    clustersResult: session.clustersResult,
    invitationResult: session.invitationResult,
    synthesizing: session.synthesizing,
  });
});

app.post('/api/admin/display', (req, res) => {
  if (!checkPin(req, res)) return;
  const { state } = req.body;
  if (!VALID_STATES.includes(state)) return res.status(400).json({ error: 'Invalid state' });
  session.displayState = state;
  res.json({ ok: true, displayState: state });
});

app.delete('/api/admin/question/:id', (req, res) => {
  if (!checkPin(req, res)) return;
  const id = parseInt(req.params.id);
  session.questions = session.questions.filter(q => q.id !== id);
  res.json({ ok: true });
});

app.delete('/api/admin/wish/:idx', (req, res) => {
  if (!checkPin(req, res)) return;
  const idx = parseInt(req.params.idx);
  if (idx >= 0 && idx < session.wishes.length) session.wishes.splice(idx, 1);
  res.json({ ok: true });
});

app.delete('/api/admin/teach/:idx', (req, res) => {
  if (!checkPin(req, res)) return;
  const idx = parseInt(req.params.idx);
  if (idx >= 0 && idx < session.teaches.length) session.teaches.splice(idx, 1);
  res.json({ ok: true });
});

app.post('/api/admin/reset', (req, res) => {
  if (!checkPin(req, res)) return;
  resetSession();
  res.json({ ok: true });
});

app.post('/api/admin/next-session', (req, res) => {
  if (!checkPin(req, res)) return;
  if (!req.body.confirm) return res.status(400).json({ error: 'Confirmation required. Send { confirm: true }.' });
  resetSession();
  res.json({ ok: true, message: 'Ready for next session' });
});

// ─── Test data — realistic faculty / admin / student responses ──────────────

app.post('/api/admin/load-test-data', (req, res) => {
  if (!checkPin(req, res)) return;
  resetSession();

  const roles = [
    'Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty','Faculty',
    'Administrator','Administrator','Administrator','Administrator','Administrator','Administrator','Administrator','Administrator',
    'Staff','Staff','Staff','Staff','Staff','Staff',
    'Grad student','Grad student','Grad student','Grad student','Grad student',
    'Undergrad','Undergrad','Undergrad','Undergrad','Undergrad','Undergrad','Undergrad',
    'Industry guest','Industry guest','Industry guest',
  ];

  // Arc distribution paired 1:1 with roles — 43 total. Mostly Assistant, fewer at Agent/Colleague.
  const arcs = [
    'Chatbot','Chatbot','Chatbot','Chatbot','Chatbot','Chatbot','Chatbot',
    'Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant','Assistant',
    'Agent','Agent','Agent','Agent','Agent','Agent','Agent','Agent',
    'Colleague','Colleague','Colleague','Colleague',
  ];

  const teaches = [
    "Paste your syllabus and ask Claude to find rubric contradictions",
    "Use NotebookLM to turn your own readings into a podcast",
    "Let Gemini read your PDF and make you a study guide",
    "Tell ChatGPT to respond 'as a skeptic' to your draft",
    "Summarize long meeting transcripts into action items",
    "Ask Claude to grade your own writing against a rubric",
    "Use AI to draft first-pass policy replies in your voice",
    "Perplexity for anything you'd Google — it cites sources",
    "Put a frustrated email into ChatGPT to find the real ask",
    "Screenshot a confusing chart, ask Claude what it means",
    "Have AI write three possible Slack replies, pick one",
    "Convert bad bullet points into a proper outline",
    "Red-team your own plan by asking 'what would fail'",
    "Ask Claude to rewrite your feedback more kindly",
    "Generate 20 quiz questions from a lecture transcript",
    "Translate code errors into plain English explanations",
    "Compare two drafts side-by-side and ask 'which is clearer'",
    "Get a second opinion on a hiring decision",
    "Use Gamma to turn an outline into a first-draft deck",
    "Ask ChatGPT to interview you about what you actually mean",
    "Have it draft the awkward email you've been avoiding",
    "Use Claude Projects to remember context across sessions",
    "Paste job description + resume, ask for mismatches",
    "Generate three alternate titles for anything you write",
    "Give it your calendar and ask what meetings to cut",
    "Have AI read student questions and cluster them",
    "Dictate rambling thoughts, ask AI to find the throughline",
    "Ask for a simpler version of any jargon-heavy paper",
    "Get it to propose counter-arguments to your position",
    "Use voice mode during a walk to talk through a problem",
    "Ask for the 'version your mother would understand'",
    "Feed it meeting notes to extract decisions vs discussion",
    "Turn your scattered notes into a working agenda",
    "Ask Claude to mimic your writing style after 3 samples",
    "Have it role-play a difficult conversation first",
    "Auto-generate alt text for images in your slides",
  ];

  const wishes = [
    "Actually join my Zoom meetings and take notes without me there",
    "Grade 60 student essays with my exact standards",
    "Manage my inbox and only surface what needs me",
    "Reconcile three budget spreadsheets that never agree",
    "Write letters of recommendation that sound like me",
    "Sit in on advising sessions and summarize them",
    "Cross-reference all my course materials for contradictions",
    "Handle the accreditation paperwork cycle autonomously",
    "Read a student's entire transcript and flag patterns",
    "Draft IRB revisions from reviewer comments automatically",
    "Plan a week of classes given the syllabus and calendar",
    "Run the registration-day troubleshooting desk",
    "Call the IT helpdesk on my behalf when something breaks",
    "Auto-schedule my office hours around student requests",
    "Compare my syllabus to last year's and flag drift",
    "Book travel that actually respects my preferences",
    "Generate a conference poster from my working paper",
    "Respond to student email over the weekend in my voice",
    "Detect when my group project is stalling and nudge people",
    "Monitor my research area and tell me what I missed",
    "Write grant progress reports from my commit history",
    "Keep my CV and website perfectly in sync automatically",
    "Actually run my lit review end-to-end, not just summaries",
    "Negotiate with the registrar for room changes",
    "Record my lecture and fix the places I rambled",
    "Plan the first week of onboarding for a new hire",
    "Handle the repetitive half of curriculum review",
    "Help me actually stop and pay attention in long meetings",
  ];

  const questionList = [
    "How do I know when AI output is actually good quality vs just confident?",
    "What should our policy be when students use AI on take-home work?",
    "Is there an ethical line for using AI in hiring decisions?",
    "How do we assess learning when AI can do the assignments?",
    "What's the single most important skill to teach alongside AI?",
    "How do I get faculty to actually try these tools instead of just debating them?",
    "Can AI evaluation tools introduce bias we haven't noticed?",
    "What's the difference between augmenting my work and outsourcing it?",
    "How do we prevent a two-tier system of AI haves and have-nots?",
    "Is it honest to use AI for emails without disclosing it?",
    "What happens to learning when friction is removed?",
    "How do I explain to my department why this isn't a fad?",
    "Should we be teaching prompt engineering or is that already obsolete?",
    "What's the right way to cite AI in academic work?",
    "How do administrators think about AI liability right now?",
    "Is there a version of AI use that makes students more curious, not less?",
    "What's the biggest thing institutions are getting wrong about AI?",
    "Do you think AI will make college education more or less valuable?",
    "How do I stay current without spending every weekend on it?",
    "What's one policy change you'd push for tomorrow?",
    "When should I verify AI output vs trust it?",
    "How do I develop my own judgment when AI is always available?",
    "Is it dishonest to use AI as a colleague and not mention it?",
    "What does 'AI literate' actually mean for a non-technical professor?",
    "Are we about to see a massive collapse of entry-level knowledge work?",
    "How do we keep faculty expertise valuable in ten years?",
    "What are faculty at other institutions doing that we aren't?",
    "How do I talk to skeptical colleagues without sounding like a cheerleader?",
    "What's the best way to build an institutional AI culture?",
    "Is there a risk in moving too fast on agentic tools?",
    "How do I get a pilot approved at a slow institution?",
    "What data privacy concerns should I have with these tools?",
    "How is AI changing what counts as original scholarship?",
    "Will peer review survive AI-generated drafts?",
    "Can AI grading actually be more fair than human grading?",
    "How do I know I'm not just being flattered by the model?",
    "What's one thing AI is genuinely bad at that we keep pretending it's good at?",
    "How do I handle a student who's clearly ahead of me on AI?",
    "What should a first-year orientation teach about AI?",
    "Is this the moment where disciplines have to redefine themselves?",
    "How do you measure whether AI use actually helped learning?",
    "What's your take on open-source vs frontier models for a university?",
    "How do we protect students from over-reliance without banning the tools?",
    "Do you think 'AI-free assignments' have a future?",
    "What's the most under-discussed harm right now?",
    "How much of this will be obsolete in a year?",
  ];

  session.roles = roles;
  session.arcs = arcs;
  session.teaches = teaches;
  session.wishes = wishes;
  questionList.forEach(text => {
    session.questions.push({ id: session.nextId++, text, timestamp: Date.now() });
  });

  res.json({ ok: true, loaded: {
    roles: session.roles.length,
    arcs: session.arcs.length,
    teaches: session.teaches.length,
    wishes: session.wishes.length,
    questions: session.questions.length,
  } });
});

// ─── Act 1: "Portrait of your practice" ─────────────────────────────────────

app.post('/api/admin/synthesize/portrait', async (req, res) => {
  if (!checkPin(req, res)) return;
  if (session.synthesizing.portrait) return res.status(409).json({ error: 'Synthesis already in progress' });
  if (session.teaches.length < 5) return res.status(400).json({ error: 'Need at least 5 "teach-a-colleague" responses' });

  session.synthesizing.portrait = true;
  try {
    const teaches = session.teaches.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const roleDist = distribution(session.roles, VALID_ROLES).map(r => `${r.label}: ${r.count}`).join(', ');

    const prompt = `You are helping a presenter at a session called "Exploring AI in Practice" for a university audience of students, faculty, staff, and administrators. The audience just submitted the one AI trick they would teach a colleague.

Room composition: ${roleDist}

AI tricks the room would teach each other:
${teaches}

Write a "portrait of this room's AI practice" mapped onto three frames from the talk:

TIME — what does the room use AI for that takes too long?
EFFORT — what does the room use AI for that's repetitive drudge?
SKILL — what does the room use AI to reach just beyond their own ability?

For each of the three frames, write ONE short sentence (under 18 words) grounded in actual submissions. Then write ONE closing line (under 22 words) that names the thing the room is quietly good at that they probably didn't notice about themselves. The closing line should make the room go briefly quiet.

Return ONLY valid JSON with no extra text, no markdown, no code fences:
{"time":"...","effort":"...","skill":"...","closing":"..."}`;

    const message = await withTimeout(
      anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
      30000
    );

    const raw = message.content[0].text.trim();
    session.portraitResult = parseClaudeJSON(raw);
    res.json({ ok: true, result: session.portraitResult });
  } catch (err) {
    console.error('Portrait synthesis error:', err);
    res.status(500).json({ error: synthesisErrorMessage(err) });
  } finally {
    session.synthesizing.portrait = false;
  }
});

// ─── Act 2: "The Frontier" — agentic workflow proposals ─────────────────────

app.post('/api/admin/synthesize/frontier', async (req, res) => {
  if (!checkPin(req, res)) return;
  if (session.synthesizing.frontier) return res.status(409).json({ error: 'Synthesis already in progress' });
  if (session.wishes.length < 3) return res.status(400).json({ error: 'Need at least 3 wish responses' });

  session.synthesizing.frontier = true;
  try {
    const wishes = session.wishes.map((w, i) => `${i + 1}. ${w}`).join('\n');

    const prompt = `You are helping a presenter demonstrate agentic AI capabilities live, at an AI-in-practice session for a university audience. The audience just submitted tasks they wish AI could do but currently can't.

All wishes:
${wishes}

Pick the THREE most interesting wishes — prioritize ones that are (a) concrete, (b) representative of many others, and (c) actually achievable with today's tools. For each, propose a specific agentic workflow that could do it today.

For each workflow:
- quote the wish verbatim (up to 100 chars)
- name 1-2 real tools (examples: Claude Code, Claude Projects, Claude Cowork, NotebookLM, Gamma, Perplexity, Zapier, MCP servers for Gmail/Slack/Calendar, custom Anthropic API agent)
- give 3 concrete steps, each under 18 words, specific enough that someone could try it next week
- add ONE honest caveat (under 18 words) — what it won't do yet, or what needs human judgment

If any of the three genuinely can't be done today, be honest: set "feasible": false and use "caveat" to explain what's missing.

Return ONLY valid JSON with no extra text, no markdown, no code fences:
{"workflows":[{"wish":"...","feasible":true,"tools":["...","..."],"steps":["...","...","..."],"caveat":"..."}]}`;

    const message = await withTimeout(
      anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
      30000
    );

    const raw = message.content[0].text.trim();
    session.frontierResult = parseClaudeJSON(raw);
    res.json({ ok: true, result: session.frontierResult });
  } catch (err) {
    console.error('Frontier synthesis error:', err);
    res.status(500).json({ error: synthesisErrorMessage(err) });
  } finally {
    session.synthesizing.frontier = false;
  }
});

// ─── Act 3: "The Meta Question" — clusters + meta + outlier ─────────────────

app.post('/api/admin/synthesize/clusters', async (req, res) => {
  if (!checkPin(req, res)) return;
  if (session.synthesizing.clusters) return res.status(409).json({ error: 'Synthesis already in progress' });
  if (session.questions.length < 5) return res.status(400).json({ error: 'Need at least 5 questions first' });

  session.synthesizing.clusters = true;
  try {
    const questions = session.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');

    const prompt = `You are helping a presenter at a session called "Exploring AI in Practice" for a university audience of students, faculty, staff, and administrators. The audience just submitted their hardest questions about AI.

All submitted questions:
${questions}

Please do the following:

1. GROUP the questions into 3-4 thematic clusters. Give each cluster a short label (3-5 words) and a count.

2. SYNTHESIZE one "meta question" (under 20 words) — the single question that, if answered well, speaks to the most people in the room, including those who didn't know how to phrase what they were feeling.

3. Write a brief rationale (under 30 words) explaining why this question captures the room.

4. SURFACE one "outlier question" — too specific or too different to fit, but worth noting. Add a brief note (under 20 words) on why it stood out.

Return ONLY valid JSON with no extra text, no markdown, no code fences:
{"clusters":[{"label":"...","count":N,"example_question":"..."}],"meta_question":"...","meta_question_rationale":"...","outlier_question":"...","outlier_note":"..."}`;

    const message = await withTimeout(
      anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      30000
    );

    const raw = message.content[0].text.trim();
    session.clustersResult = parseClaudeJSON(raw);
    res.json({ ok: true, result: session.clustersResult });
  } catch (err) {
    console.error('Clusters synthesis error:', err);
    res.status(500).json({ error: synthesisErrorMessage(err) });
  } finally {
    session.synthesizing.clusters = false;
  }
});

// ─── Act 4: "The Invitation" — AI suggests new use cases ────────────────────

app.post('/api/admin/synthesize/invitation', async (req, res) => {
  if (!checkPin(req, res)) return;
  if (session.synthesizing.invitation) return res.status(409).json({ error: 'Synthesis already in progress' });
  if (session.teaches.length < 5) return res.status(400).json({ error: 'Need at least 5 "teach-a-colleague" responses' });

  session.synthesizing.invitation = true;
  try {
    const roleDist = distribution(session.roles, VALID_ROLES).map(r => `${r.label}: ${r.count}`).join(', ');
    const arcDist = distribution(session.arcs, VALID_ARCS).map(r => `${r.label}: ${r.count}`).join(', ');
    const teaches = session.teaches.join(' | ');
    const wishes = session.wishes.join(' | ');

    const prompt = `You are an attentive colleague looking across a room of university students, faculty, staff, and administrators at an AI-in-practice session. You have seen what they already do with AI and what they wish AI could do. Now you have one job: notice something they haven't, and suggest 2-3 specific new use cases this particular room hasn't mentioned but would clearly benefit from.

Room composition — roles: ${roleDist}
Room composition — arc stage: ${arcDist}
What they teach each other: ${teaches}
What they wish AI could do: ${wishes}

Write 3 suggestions. Each suggestion:
- Opens with "Have you tried…" or a similar warm, colleague-like framing
- Names at least one real tool (examples: Claude Projects, Claude Code, NotebookLM, Gamma, Perplexity, ElevenLabs, Cowork, MCP servers)
- Targets a specific over-represented role or arc-stage in the room (e.g. "For the 14 administrators here" or "For those still at the Chatbot stage")
- Fits in 2 sentences, under 40 words each suggestion
- Is concrete enough to try tomorrow morning

The tone is warm, curious, and specific — a friend who noticed something, not a consultant. Avoid generic advice. Avoid hype. These should feel like a colleague slipping you a tip.

Also write ONE closing line (under 22 words) to the whole room — the "pick one tool, one task, one colleague" invitation, phrased specifically for this audience.

Return ONLY valid JSON with no extra text, no markdown, no code fences:
{"suggestions":[{"audience":"...","text":"...","tool":"..."}],"closing":"..."}`;

    const message = await withTimeout(
      anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
      30000
    );

    const raw = message.content[0].text.trim();
    session.invitationResult = parseClaudeJSON(raw);
    res.json({ ok: true, result: session.invitationResult });
  } catch (err) {
    console.error('Invitation synthesis error:', err);
    res.status(500).json({ error: synthesisErrorMessage(err) });
  } finally {
    session.synthesizing.invitation = false;
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🧭 AI in Practice running at http://localhost:${PORT}`);
  console.log(`   Submit:  http://localhost:${PORT}/submit`);
  console.log(`   Admin:   http://localhost:${PORT}/admin   (PIN: ${ADMIN_PIN})`);
  console.log(`   Display: http://localhost:${PORT}/display\n`);
});
