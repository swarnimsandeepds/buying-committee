// The Buying Committee: server
// Zero dependencies. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const EVENTS_FILE = path.join(DATA, 'events.jsonl');
fs.mkdirSync(DATA, { recursive: true });

// ---------- .env ----------
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}
const PORT = Number(process.env.PORT) || 3000;
// With no API key, fall back to the Claude Code CLI if it is installed (uses that login, no key needed).
const CLAUDE_CLI = process.env.LLM_PROVIDER === 'mock' ? null
  : [path.join(os.homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'].find((c) => fs.existsSync(c)) || null;
const PROVIDER = process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENAI_API_KEY ? 'openai' : CLAUDE_CLI ? 'claude-cli' : 'mock';
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'anthropic' ? 'claude-haiku-5-5' : PROVIDER === 'claude-cli' ? 'haiku' : 'gpt-4o-mini');

// ---------- Agents ----------
const TOPICS = ['cost', 'roi', 'security', 'integration', 'usability', 'adoption', 'credibility'];
const AGENTS = [
  { id: 'cfo', name: 'Dana', role: 'CFO', cares: ['cost', 'roi', 'credibility'],
    persona: 'Numbers first, calm and courteous. You have seen deals fail on weak math, so you ask for a payback period, but you ask kindly and you say so when a number is good.' },
  { id: 'cto', name: 'Raj', role: 'CTO', cares: ['security', 'integration', 'credibility'],
    persona: 'Technical, thoughtful and polite. A past vendor breach made you careful, so you ask for specifics, but you explain why you are asking and you respect honest answers.' },
  { id: 'user', name: 'Maya', role: 'Head of Sales Ops', cares: ['usability', 'adoption', 'credibility'],
    persona: 'Warm, encouraging and protective of your team. Your people are tired of new tools, so you want to know what changes on Monday morning, and you help the vendor explain it.' },
];
const agentById = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

// ---------- Event ledger ----------
let allEvents = [];
try {
  allEvents = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch (_) {}
let session = null;

function logEvent(e) {
  const ev = {
    event_id: crypto.randomUUID(),
    session_id: session.id,
    seq: session.seq++,
    ts: new Date().toISOString(),
    type: e.type,
    agent: e.agent || null,
    topic: e.topic || null,
    score: typeof e.score === 'number' ? e.score : null,
    quote: e.quote || null,
    reason: e.reason || null,
    text: e.text || null,
  };
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n');
  allEvents.push(ev);
  session.events.push(ev);
  bandMirror(ev);
  return ev;
}

// ---------- Bruin ----------
const BRUIN_CANDIDATES = ['bruin', path.join(os.homedir(), '.local', 'bin', 'bruin'), '/usr/local/bin/bruin', '/opt/homebrew/bin/bruin'];
let bruinBin = null;
let bruinStatus = 'not checked';
let bruinQueue = Promise.resolve();

function run(bin, args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: ROOT, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}
async function findBruin() {
  for (const c of BRUIN_CANDIDATES) {
    try { await run(c, ['version'], 8000); bruinBin = c; bruinStatus = 'ready'; return; } catch (_) {}
  }
  bruinStatus = 'not installed';
}
async function bruinQuery(sql) {
  const out = await run(bruinBin, ['query', '--connection', 'duckdb-default', '--query', sql, '--output', 'json'], 20000);
  const j = JSON.parse(out.slice(out.indexOf('{') >= 0 && (out.indexOf('[') < 0 || out.indexOf('{') < out.indexOf('[')) ? out.indexOf('{') : out.indexOf('[')));
  if (Array.isArray(j)) return j;
  const cols = (j.columns || []).map((c) => (typeof c === 'string' ? c : c.name));
  return (j.rows || []).map((r) => (Array.isArray(r) ? Object.fromEntries(r.map((v, i) => [cols[i], v])) : r));
}

function localInsight() {
  const mine = session.events.filter((e) => e.type === 'claim_score' && e.score != null && e.topic);
  const agg = (rows, keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      const o = m.get(k) || { sum: 0, n: 0, r };
      o.sum += r.score; o.n++; m.set(k, o);
    }
    return [...m.values()].map((o) => ({ ...o, avg: Math.round((o.sum / o.n) * 100) / 100 }));
  };
  const weak = agg(mine, (r) => r.topic).map((o) => ({ topic: o.r.topic, avg_score: o.avg, n_scores: o.n })).sort((a, b) => a.avg_score - b.avg_score || b.n_scores - a.n_scores);
  const table = agg(mine, (r) => r.agent + '|' + r.topic).map((o) => ({ agent: o.r.agent, topic: o.r.topic, avg_score: o.avg, n_scores: o.n }));
  const hist = agg(allEvents.filter((e) => e.type === 'claim_score' && e.score != null && e.topic && e.session_id !== session.id), (r) => r.topic)
    .map((o) => ({ topic: o.r.topic, avg_score: o.avg, n_scores: o.n })).sort((a, b) => a.avg_score - b.avg_score);
  const claims = mine.filter((e) => e.quote).sort((a, b) => a.score - b.score || a.seq - b.seq).slice(0, 3)
    .map((e) => ({ agent: e.agent, topic: e.topic, score: e.score, quote: e.quote, reason: e.reason }));
  return { weak, table, hist, claims };
}

// Extra data for the final report: strongest claims and the score trend. Call after refreshInsight().
async function reportData() {
  const sid = session.id.replace(/[^a-f0-9-]/g, '');
  const num = (rows) => { for (const r of rows) for (const f of ['score', 'running_avg', 'step', 'seq']) if (r[f] != null) r[f] = Number(r[f]); return rows; };
  if (bruinBin && session.insight && session.insight.source === 'bruin') {
    try {
      const pros = await bruinQuery(`SELECT agent, topic, score, quote, reason FROM analytics.strongest_claims WHERE session_id = '${sid}' ORDER BY claim_rank LIMIT 3`);
      const trend = await bruinQuery(`SELECT step, agent, topic, score, quote, reason, running_avg FROM analytics.score_trend WHERE session_id = '${sid}' ORDER BY step`);
      return { pros: num(pros), trend: num(trend) };
    } catch (e) { console.error('[bruin] report query failed, using local fallback: ' + String(e.stderr || e.message).slice(0, 300)); }
  }
  const mine = session.events.filter((e) => e.type === 'claim_score' && e.score != null && e.topic);
  let sum = 0;
  const trend = mine.map((e, i) => { sum += e.score; return { step: i + 1, agent: e.agent, topic: e.topic, score: e.score, quote: e.quote, reason: e.reason, running_avg: Math.round((sum / (i + 1)) * 100) / 100 }; });
  const pros = mine.filter((e) => e.quote).sort((a, b) => b.score - a.score || a.seq - b.seq).slice(0, 3).map((e) => ({ agent: e.agent, topic: e.topic, score: e.score, quote: e.quote, reason: e.reason }));
  return { pros, trend };
}

// Runs the Bruin pipeline, then reads the analytics tables back. Falls back to in-process math if Bruin is unavailable.
function refreshInsight() {
  const job = bruinQueue.then(async () => {
    const t0 = Date.now();
    let data = null, source = 'local', note = '';
    if (bruinBin) {
      try {
        await run(bruinBin, ['run', 'pipeline']);
        const sid = session.id.replace(/[^a-f0-9-]/g, '');
        // DuckDB allows one process on the file at a time, so these run one after another, not in parallel.
        const weak = await bruinQuery(`SELECT topic, avg_score, n_scores FROM analytics.weak_topics WHERE session_id = '${sid}' ORDER BY weakness_rank`);
        const table = await bruinQuery(`SELECT agent, topic, avg_score, n_scores FROM analytics.topic_scores WHERE session_id = '${sid}'`);
        const hist = await bruinQuery(`SELECT topic, round(avg(score), 2) AS avg_score, count(*) AS n_scores FROM raw.events WHERE type = 'claim_score' AND session_id <> '${sid}' AND score IS NOT NULL GROUP BY topic ORDER BY avg_score`);
        const claims = await bruinQuery(`SELECT agent, topic, score, quote, reason FROM analytics.weakest_claims WHERE session_id = '${sid}' ORDER BY claim_rank LIMIT 3`);
        data = { weak, table, hist, claims }; source = 'bruin'; bruinStatus = 'ready';
      } catch (e) {
        note = String(e.stderr || e.stdout || e.message || e).trim().split('\n').slice(-6).join('\n');
        bruinStatus = 'error';
        console.error('[bruin] failed, using local fallback:\n' + note);
      }
    }
    if (!data) data = localInsight();
    const num = (v) => (typeof v === 'number' ? v : Number(v));
    for (const k of ['weak', 'table', 'hist', 'claims']) for (const r of data[k]) for (const f of ['avg_score', 'n_scores', 'score']) if (r[f] != null) r[f] = num(r[f]);
    session.insight = { ...data, source, ms: Date.now() - t0, rows: session.events.length, note, weakest: data.weak[0] || null };
    return session.insight;
  });
  bruinQueue = job.catch(() => {});
  return job;
}

// ---------- BAND (optional) ----------
// Each committee member is a BAND remote agent. Every session gets a BAND room where the agents
// post their questions, arguments and votes to each other, and each agent reads what its
// colleagues addressed to it on BAND before it argues or votes.
const BAND_URL = (process.env.BAND_URL || 'https://app.band.ai/api/v1').replace(/\/$/, '');
const BAND_KEYS = { cfo: process.env.BAND_CFO_KEY, cto: process.env.BAND_CTO_KEY, user: process.env.BAND_USER_KEY };
const band = { status: 'off', me: {}, room: null, queue: Promise.resolve() };

async function bandApi(agentId, method, pathname, body) {
  const r = await fetch(BAND_URL + pathname, {
    method, headers: { 'content-type': 'application/json', 'x-api-key': BAND_KEYS[agentId] },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`BAND ${method} ${pathname} -> ${r.status} ${JSON.stringify(j.error || j).slice(0, 200)}`);
  return j.data;
}
async function bandInit() {
  if (!AGENTS.every((a) => BAND_KEYS[a.id])) return;
  try {
    for (const a of AGENTS) band.me[a.id] = await bandApi(a.id, 'GET', '/agent/me');
    band.status = 'ready';
  } catch (e) { band.status = 'error'; console.error('[band] ' + e.message); }
}
function bandDo(fn) {
  if (band.status !== 'ready') return band.queue;
  band.queue = band.queue.then(fn).catch((e) => console.error('[band] ' + e.message));
  return band.queue;
}
function bandOpenRoom() {
  band.room = null;
  return bandDo(async () => {
    const room = await bandApi('cfo', 'POST', '/agent/chats', { chat: { title: 'Buying Committee ' + new Date().toISOString().slice(0, 16).replace('T', ' ') } });
    const ownerId = band.me.cfo.owner_uuid || band.me.cfo.owner_id;
    for (const id of [band.me.cto.id, band.me.user.id, ownerId].filter(Boolean)) {
      try { await bandApi('cfo', 'POST', `/agent/chats/${room.id}/participants`, { participant: { participant_id: id, role: 'member' } }); }
      catch (e) { console.error('[band] ' + e.message); }
    }
    band.room = room.id;
    console.log('[band] room ' + room.id);
  });
}
// An agent posts to the room, addressed to its two colleagues (BAND requires a mention).
function bandPost(agentId, text) {
  return bandDo(async () => {
    if (!band.room) return;
    const others = AGENTS.filter((a) => a.id !== agentId).map((a) => band.me[a.id]);
    await bandApi(agentId, 'POST', `/agent/chats/${band.room}/messages`, {
      message: { content: others.map((o) => '@' + o.handle).join(' ') + ' ' + String(text).slice(0, 1800), mentions: others.map((o) => ({ id: o.id, handle: o.handle, name: o.name })) },
    });
  });
}
// What colleagues said to this agent on BAND, as plain text for its prompt.
async function bandInbox(agentId) {
  if (band.status !== 'ready') return '';
  await band.queue;
  if (!band.room) return '';
  try {
    const msgs = await bandApi(agentId, 'GET', `/agent/chats/${band.room}/context?limit=30`);
    const names = Object.fromEntries(AGENTS.map((a) => [band.me[a.id].id, a.name]));
    const lines = (Array.isArray(msgs) ? msgs : []).filter((m) => m.sender_id && m.sender_id !== band.me[agentId].id && names[m.sender_id])
      .sort((a, b) => String(a.inserted_at).localeCompare(String(b.inserted_at))).slice(-8)
      .map((m) => `${names[m.sender_id]}: ${String(m.content || '').replace(/@\[\[[^\]]*\]\]|@\S+\/\S+/g, '').trim()}`);
    return lines.length ? `\nMessages your colleagues sent you in the committee's BAND room:\n${lines.join('\n')}\n` : '';
  } catch (e) { console.error('[band] ' + e.message); return ''; }
}
function bandMirror(ev) {
  if (band.status !== 'ready') return;
  const asker = session.pending ? session.pending.agent : 'cfo';
  if (ev.type === 'pitch') bandPost('cfo', 'The vendor pitched: ' + ev.text);
  else if (ev.type === 'question') bandPost(ev.agent, `My question to the vendor (${ev.topic}): ${ev.text} Why: ${ev.reason || ''}`);
  else if (ev.type === 'answer') bandPost(asker, 'The vendor answered me: ' + ev.text);
  else if (ev.type === 'insight') bandPost('cfo', 'Pipeline update. ' + ev.text);
  else if (ev.type === 'research') bandPost('cto', `I checked the web. ${ev.text} ${ev.reason || ''}`);
  else if (ev.type === 'deliberation') bandPost(ev.agent, `${ev.text} (${ev.reason || ''})`);
  else if (ev.type === 'vote') bandPost(ev.agent, `My vote: ${ev.topic}. ${ev.text}`);
  else if (ev.type === 'verdict') bandPost('cfo', 'Verdict: ' + ev.text);
}

// ---------- Telem (optional) ----------
// Live web research. Raj picks the most checkable claim in the pitch, searches the web through Telem,
// and the committee uses what he finds. All calls of one pitch share a Telem session, so the whole
// research trail shows up as one trace in the Telem console.
const TELEM_URL = (process.env.TELEM_BASE_URL || 'https://router.telem.ai').replace(/\/$/, '');
const telem = { status: process.env.TELEM_API_KEY ? 'ready' : 'off' };
async function telemSearch(query) {
  const body = { user_input: { query }, search: { num_results: 3 } };
  if (session.telemSession) body.session_id = session.telemSession;
  const r = await fetch(TELEM_URL + '/v1/search', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.TELEM_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Telem search -> ${r.status} ${JSON.stringify(j.detail || j.error || j).slice(0, 200)}`);
  if (j.session_id) session.telemSession = j.session_id;
  const seen = new Set(), out = [];
  for (const run of j.preprocessor_runs || []) for (const x of (run.output_payload && run.output_payload.results) || []) {
    if (!x.url || seen.has(x.url)) continue;
    seen.add(x.url);
    out.push({ title: String(x.title || x.url).slice(0, 120), url: x.url, summary: String(x.summary || x.excerpt || '').replace(/\s+/g, ' ').slice(0, 320) });
  }
  return out.slice(0, 4);
}
async function research(pitch) {
  if (telem.status === 'off') return null;
  const raj = agentById.cto;
  try {
    const pickd = await llmJSON(raj, `The vendor just pitched: "${pitch}"\n\nBefore the committee questions them, you will check ONE thing on the live web. Pick the claim that matters most to the business case and that outsiders can verify: prefer a number (a time saving, a price level, an adoption or payback benchmark) over a certification or compliance badge. Write one web search query for it.
Return JSON: {"claim":"<the vendor's claim, max 14 words>","query":"<web search query, max 12 words>"}`,
      () => ({ claim: firstWords(pitch, 12), query: firstWords(pitch, 10) + ' industry benchmark' }));
    const results = await telemSearch(String(pickd.query).slice(0, 200));
    telem.status = 'ready';
    if (!results.length) return null;
    session.research = `Raj checked the vendor's claim "${pickd.claim}" on the live web (via Telem search, query: "${pickd.query}"). Findings:\n` +
      results.map((x, i) => `${i + 1}. ${x.title}: ${x.summary} (${x.url})`).join('\n');
    return logEvent({ type: 'research', agent: 'cto', topic: 'credibility', quote: String(pickd.claim).slice(0, 160),
      text: `Checked the web for "${pickd.query}". Top sources: ${results.map((x) => x.title).join(' | ')}`.slice(0, 600),
      reason: `Telem search, ${results.length} sources. ${results[0].summary.slice(0, 160)} (${results[0].url})` });
  } catch (e) { telem.status = 'error'; console.error('[telem] ' + e.message); return null; }
}
// Only Raj (who ran the search) carries the findings, plus whoever asks the first question.
// Everyone is told to raise it once at most, so one web finding does not take over the session.
const researchNote = (agentId, first) => (session.research && (agentId === 'cto' || first)
  ? `\n${session.research}\nIf this matters, raise it ONCE, briefly. If it has already come up in the conversation, do not repeat it: move on to your own concerns.\n` : '');

// ---------- LLM ----------
function claudeCli(system, user) {
  return new Promise((resolve, reject) => {
    const child = execFile(CLAUDE_CLI, ['-p', '--model', MODEL, '--output-format', 'text', '--system-prompt', system],
      { cwd: os.tmpdir(), timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error('Claude CLI: ' + String(stderr || err.message).slice(0, 300))) : resolve(stdout)));
    child.stdin.end(user);
  });
}
async function llmRaw(system, user) {
  if (PROVIDER === 'claude-cli') return claudeCli(system, user);
  if (PROVIDER === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Anthropic API: ' + JSON.stringify(j.error || j));
    return j.content.map((c) => c.text || '').join('');
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({ model: MODEL, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('OpenAI API: ' + JSON.stringify(j.error || j));
  return j.choices[0].message.content;
}
async function llmJSON(agent, task, mock) {
  if (PROVIDER === 'mock') { await new Promise((r) => setTimeout(r, 250)); return mock(); }
  const system = `You are ${agent.name}, the ${agent.role} on a three person buying committee evaluating a vendor's sales pitch. The other members are ${AGENTS.filter((a) => a.id !== agent.id).map((a) => `${a.name} (${a.role})`).join(' and ')}.
Personality: ${agent.persona}
You care most about: ${agent.cares.join(', ')}.
You have your own goals and you do not automatically agree with your colleagues.
Tone: you are here to help this person get better at pitching. Be respectful, empathetic and constructive. Never be rude, sarcastic or dismissive. Acknowledge what was good or honest before you raise a concern, thank them for clear answers, and phrase concerns as what would help you say yes. You can still be rigorous: kindness is in how you say it, not in lowering your standards.
Everything you say will be spoken aloud, so use short natural spoken sentences. No markdown, no emojis.
Reply with ONLY one valid JSON object and nothing else.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const txt = await llmRaw(system, task);
      const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
      return JSON.parse(txt.slice(s, e + 1));
    } catch (err) {
      console.error(`[llm] ${agent.name} attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 1) return mock();
    }
  }
}

function transcript() {
  return session.events
    .filter((e) => ['pitch', 'question', 'answer', 'deliberation'].includes(e.type))
    .map((e) => (e.agent ? `${agentById[e.agent].name} (${agentById[e.agent].role})` : 'VENDOR') + ': ' + e.text)
    .join('\n');
}
const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n) * 10) / 10 || 0));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const firstWords = (t, n) => String(t).trim().split(/\s+/).slice(0, n).join(' ');

function agentState() {
  return AGENTS.map((a) => {
    const s = session.events.filter((e) => e.type === 'claim_score' && e.agent === a.id);
    return { id: a.id, name: a.name, role: a.role, score: s.length ? Math.round((s.reduce((x, e) => x + e.score, 0) / s.length) * 10) / 10 : null };
  });
}

// An agent scores what the vendor just said. Returns ledger events.
async function evaluate(agent, said, context) {
  const out = await llmJSON(agent, `Conversation so far:\n${transcript()}\n\n${context}\nThe vendor just said: "${said}"\n\nScore what the vendor just said, only on topics it actually touched. Allowed topics: ${TOPICS.join(', ')}. Be a fair, encouraging grader: vague claims with no numbers or proof score 3 to 5, specific and believable claims score 7 to 9, and honest admissions of what they do not know yet deserve credit. Write each reason as helpful coaching, not criticism.
Return JSON: {"scores":[{"topic":"<allowed topic>","score":<0-10>,"quote":"<exact short phrase the vendor said, max 14 words>","reason":"<why, max 18 words>"}],"reaction":"<one warm, respectful spoken sentence reacting to the vendor, max 16 words>"}
Give 1 to 2 items in scores.`,
    () => ({
      scores: [{ topic: pick(agent.cares), score: 2 + Math.floor(Math.random() * 7), quote: firstWords(said, 9), reason: 'Demo mode score. Add an API key for real judgment.' }],
      reaction: pick(['Thank you. A number or two would help me here.', 'That is clearer, thank you. Please keep going.', 'I appreciate that. I would like a bit more detail.', 'That helps, thank you.']),
    }));
  const events = [];
  for (const s of (out.scores || []).slice(0, 2)) {
    if (!TOPICS.includes(s.topic)) s.topic = agent.cares[0];
    events.push(logEvent({ type: 'claim_score', agent: agent.id, topic: s.topic, score: clamp(s.score), quote: String(s.quote || '').slice(0, 160), reason: String(s.reason || '').slice(0, 220) }));
  }
  if (out.reaction) events.push({ ...logEvent({ type: 'reaction', agent: agent.id, text: String(out.reaction) }), say: String(out.reaction) });
  return events;
}

async function draftQuestion(agent, latestAnswer) {
  const ins = session.insight;
  const w = ins && ins.weakest;
  const asked = session.events.filter((e) => e.type === 'question').map((e) => `${agentById[e.agent].name} asked about ${e.topic}`).join('; ') || 'none yet';
  const mineW = ((ins && ins.weak) || []).filter((x) => agent.cares.includes(x.topic));
  const focus = mineW.length ? mineW[0] : null;
  const hist = ins && ins.hist.length ? `In earlier sessions this same vendor was weakest on: ${ins.hist.slice(0, 2).map((h) => `${h.topic} (${h.avg_score}/10)`).join(', ')}.` : '';
  const out = await llmJSON(agent, `Conversation so far:\n${transcript()}\n${latestAnswer ? `(The vendor's latest answer is the last line above; your colleague is scoring it right now.)\n` : ''}\nLive analytics from the committee's shared data pipeline: ${w ? `the vendor's weakest topic right now is "${w.topic}" at ${w.avg_score}/10 across ${w.n_scores} scores.` : 'no scores yet.'} ${hist}
Questions already asked: ${asked}.
${researchNote(agent.id, !session.events.some((e) => e.type === 'question'))}
Ask the vendor ONE clear question, max 30 words, in a friendly and respectful way. Start with a brief acknowledgement of something they said well, then ask about ${focus ? `"${focus.topic}" (${focus.avg_score}/10, the weakest of the topics you personally own)` : `"${agent.cares[0]}", which you own and nobody has scored yet`}. Stay inside your own role: do not ask about topics that belong to a colleague. If it was already asked about twice, or is far outside your concerns, press on your own top concern instead. Do not repeat an earlier question.
Return JSON: {"question":"<spoken question>","topic":"<one of ${TOPICS.join(', ')}>","reason":"<why you chose this, max 18 words, mention the analytics if you used them>"}`,
    () => {
      const topic = focus ? focus.topic : agent.cares[0];
      return { question: `Thanks for that. Could you share one concrete number or proof point on ${topic}? It would really help us.`, topic, reason: `Pipeline shows ${topic} is the weakest topic so far.` };
    });
  if (!TOPICS.includes(out.topic)) out.topic = agent.cares[0];
  return { agent, out };
}
function commitQuestion({ agent, out }) {
  const ev = logEvent({ type: 'question', agent: agent.id, topic: out.topic, text: String(out.question), reason: String(out.reason || '') });
  session.pending = { agent: agent.id, question: ev.text };
  return { ...ev, say: ev.text };
}

const askQuestion = async (agent) => commitQuestion(await draftQuestion(agent));

function insightEvent() {
  const i = session.insight;
  if (!i || !i.weakest) return null;
  const text = `Weakest topic: ${i.weakest.topic} at ${i.weakest.avg_score}/10 (${i.weakest.n_scores} scores, ${i.rows} ledger rows, ${i.ms} ms)`;
  return { ...logEvent({ type: 'insight', topic: i.weakest.topic, score: i.weakest.avg_score, text, reason: i.source === 'bruin' ? 'Computed by the Bruin pipeline' : 'Local fallback, Bruin not available' }), source: i.source };
}

const QA_TURNS = Number(process.env.QA_TURNS) || 2; // the committee decides after two questions
// Who asks next: a member who has not asked yet, preferring the one whose concerns cover the weakest topic.
function pickAsker() {
  const asked = new Set(session.events.filter((e) => e.type === 'question').map((e) => e.agent));
  const free = AGENTS.filter((a) => !asked.has(a.id));
  const pool = free.length ? free : AGENTS;
  const weak = session.insight && session.insight.weakest ? session.insight.weakest.topic : null;
  const own = pool.filter((a) => a.cares.slice(0, 2).includes(weak)); // the first two concerns are the member's own; credibility is shared
  return own[0] || pool.find((a) => a.cares.includes(weak)) || pool[0];
}
// The committee stops early when it has already made up its mind: after the first answer, if all
// three members score the vendor clearly high or clearly low, another question would not change the vote.
function committeeDecided() {
  if (session.turn < 1) return null;
  const sc = agentState().map((a) => a.score).filter((x) => x != null);
  if (sc.length < AGENTS.length) return null;
  if (sc.every((x) => x >= 7.5)) return 'All three members already score the vendor 7.5 or higher. No more questions needed.';
  if (sc.every((x) => x <= 3.5)) return 'All three members already score the vendor 3.5 or lower. No more questions needed.';
  return null;
}

async function handlePitch(text) {
  session = { id: crypto.randomUUID(), seq: 0, events: [], turn: 0, step: 0, insight: null, pending: null, leanings: {}, research: null, telemSession: null };
  bandOpenRoom();
  logEvent({ type: 'pitch', text });
  // Long term memory: what earlier sessions looked like, read before anyone speaks.
  const before = localInsight().hist;
  const memory = before.length ? `Committee memory: in earlier sessions this vendor was weakest on ${before.slice(0, 2).map((h) => h.topic).join(' and ')}.` : '';
  const [found, ...results] = await Promise.all([research(text), ...AGENTS.map((a) => evaluate(a, text, memory))]);
  const events = results.flat();
  if (found) events.push(found);
  await refreshInsight();
  const ie = insightEvent(); if (ie) events.push(ie);
  events.push(await askQuestion(pickAsker()));
  return { events, agents: agentState(), insight: session.insight, pending: session.pending, done: false };
}

async function handleAnswer(text) {
  if (!session || !session.pending) throw new Error('No question is pending. Start with a pitch.');
  const asker = agentById[session.pending.agent];
  logEvent({ type: 'answer', text });
  session.pending = null;
  const last = session.turn + 1 >= QA_TURNS;
  // The next question is written while the answer is being scored, so the vendor waits once, not twice.
  const nextQ = last ? null : draftQuestion(pickAsker(), text);
  const events = await evaluate(asker, text, `${asker.name} asked the vendor a question and this is the answer.${researchNote(asker.id)}`);
  await refreshInsight();
  const ie = insightEvent(); if (ie) events.push(ie);
  session.turn++;
  const early = committeeDecided();
  if (early && session.turn < QA_TURNS) events.push(logEvent({ type: 'insight', text: 'Committee is ready to decide early. ' + early, reason: 'Scores are unanimous, so the remaining questions were skipped' }));
  const done = session.turn >= QA_TURNS || !!early;
  if (!done) events.push(commitQuestion(await nextQ));
  if (done) prefetchStep();
  return { events, agents: agentState(), insight: session.insight, pending: session.pending, done };
}

// Deliberation: steps 0-2 each agent argues, steps 3-5 each agent votes, step 6 verdict.
function prefetchStep() {
  const sid = session.id;
  session.nextStep = computeStep().catch((e) => ({ error: e }));
  session.nextStep.sid = sid;
}
async function handleStep() {
  if (!session) throw new Error('No session.');
  const ready = session.nextStep || computeStep();
  session.nextStep = null;
  const res = await ready;
  if (res && res.error) throw res.error;
  if (res.phase !== 'verdict') prefetchStep();
  return res;
}
async function computeStep() {
  const step = session.step++;
  const state = agentState();
  const ins = session.insight || { weak: [], claims: [] };
  const board = `Shared scoreboard from the data pipeline: ${ins.weak.map((w) => `${w.topic} ${w.avg_score}/10`).join(', ') || 'no scores'}. Your own average score of this vendor: ${(state.find((s) => s.id === AGENTS[step % 3].id) || {}).score ?? 'none'}/10.`;
  if (step < 3) {
    const a = AGENTS[step];
    const inbox = await bandInbox(a.id);
    const out = await llmJSON(a, `The vendor has left the room. The committee is now deliberating.\nFull conversation:\n${transcript()}\n\n${board}\n${researchNote(a.id)}${inbox}\nSpeak to your colleagues by name. Give your position in max 34 words. Be fair to the vendor: name one thing they did well as well as your concern. Disagree with a colleague politely if your concerns differ.
Return JSON: {"say":"<spoken statement>","leaning":"BUY" | "NO_BUY" | "UNSURE","reason":"<max 15 words>"}`,
      () => {
        const sc = (state.find((s) => s.id === a.id) || {}).score ?? 5;
        return { say: sc >= 5.5 ? 'I can live with this. The answers on my side held up.' : 'I am not there. Too many of my questions got soft answers.', leaning: sc >= 5.5 ? 'BUY' : 'NO_BUY', reason: `My average score is ${sc}.` };
      });
    session.leanings[a.id] = out.leaning;
    const ev = logEvent({ type: 'deliberation', agent: a.id, text: String(out.say), reason: `Leaning ${out.leaning}. ${out.reason || ''}` });
    return { events: [{ ...ev, say: ev.text }], agents: state, phase: 'deliberation' };
  }
  if (step < 6) {
    if (!session.votes) session.votes = AGENTS.map((a) => castVote(a, state, board));
    const a = AGENTS[step - 3];
    const out = await session.votes[step - 3];
    const vote = out.vote === 'BUY' ? 'BUY' : 'NO_BUY';
    const ev = logEvent({ type: 'vote', agent: a.id, text: String(out.say), topic: vote, reason: (out.changed_mind ? 'Changed mind. ' : '') + String(out.reason || '') });
    return { events: [{ ...ev, say: ev.text, vote }], agents: state, phase: 'vote' };
  }
  const votes = session.events.filter((e) => e.type === 'vote');

  const buys = votes.filter((v) => v.topic === 'BUY').length;
  const verdict = buys >= 2 ? 'BUY' : 'NO BUY';
  await refreshInsight();
  const i = session.insight;
  const rep = await reportData();
  const ev = logEvent({ type: 'verdict', topic: verdict, text: `${verdict}, ${buys} to ${votes.length - buys}`, reason: 'Majority vote of the committee' });
  return {
    events: [ev], agents: state, phase: 'verdict',
    verdict: {
      result: verdict, buys, total: votes.length,
      votes: votes.map((v) => ({ agent: v.agent, vote: v.topic, say: v.text, reason: v.reason })),
      claims: i.claims, weak: i.weak, table: i.table, hist: i.hist, source: i.source, pros: rep.pros, trend: rep.trend, rows: i.rows,
    },
  };
}

async function castVote(a, state, board0) {
    const board = board0.replace(/Your own average score of this vendor: .*$/, `Your own average score of this vendor: ${(state.find((x) => x.id === a.id) || {}).score ?? 'none'}/10.`);
    const inbox = await bandInbox(a.id);
    const out = await llmJSON(a, `The committee has deliberated. Full conversation including the deliberation:\n${transcript()}\n\n${board}\n${researchNote(a.id)}${inbox}Your leaning before hearing everyone: ${session.leanings[a.id] || 'UNSURE'}.\n\nCast your final vote. You may change your mind if a colleague made a good point.
Return JSON: {"vote":"BUY" | "NO_BUY","say":"<spoken vote with one kind, constructive sentence of why and what would change your mind, max 26 words>","reason":"<the single biggest factor, max 15 words>","changed_mind":true | false}`,
      () => {
        const sc = (state.find((s) => s.id === a.id) || {}).score ?? 5;
        const vote = sc >= 5.5 ? 'BUY' : 'NO_BUY';
        return { vote, say: vote === 'BUY' ? 'I vote buy.' : 'I vote no.', reason: `Average score ${sc} out of 10.`, changed_mind: false };
      });
    return out;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}
let busy = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/status') {
        return send(res, 200, { maxQuestions: QA_TURNS, provider: PROVIDER, model: MODEL, bruin: bruinStatus, band: band.status, telem: telem.status, bandRoom: band.room, agents: AGENTS.map(({ id, name, role, cares }) => ({ id, name, role, cares })), topics: TOPICS, pastSessions: new Set(allEvents.map((e) => e.session_id)).size });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      if (busy) return send(res, 429, { error: 'The committee is still thinking.' });
      busy = true;
      try {
        const body = await readBody(req);
        const text = String(body.text || '').trim().slice(0, 4000);
        if (url.pathname === '/api/pitch') { if (!text) throw new Error('Say something first.'); return send(res, 200, await handlePitch(text)); }
        if (url.pathname === '/api/answer') { if (!text) throw new Error('Say something first.'); return send(res, 200, await handleAnswer(text)); }
        if (url.pathname === '/api/step') return send(res, 200, await handleStep());
        return send(res, 404, { error: 'Unknown endpoint' });
      } finally { busy = false; }
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: e.message });
    }
  }
  let p = path.normalize(path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
  if (!p.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

Promise.all([findBruin(), bandInit()]).then(() => {
  server.listen(PORT, () => {
    console.log(`\n  The Buying Committee is running:  http://localhost:${PORT}\n`);
    console.log(`  LLM:   ${PROVIDER === 'mock' ? 'DEMO MODE (no API key found in .env, agents use canned lines)' : PROVIDER + ' / ' + MODEL}`);
    console.log(`  Bruin: ${bruinBin ? 'found at ' + bruinBin : 'NOT FOUND. Install it, then restart. Using local fallback for now.'}\n`);
    console.log(`  BAND:  ${band.status === 'ready' ? 'connected as ' + AGENTS.map((a) => band.me[a.id].handle).join(', ') : band.status === 'off' ? 'off (add the three BAND_*_KEY values to .env to turn it on)' : 'ERROR, see above'}\n`);
    console.log(`  Telem: ${telem.status === 'ready' ? 'on (live web fact-check)' : 'off (add TELEM_API_KEY to .env to turn it on)'}\n`);
  });
});
