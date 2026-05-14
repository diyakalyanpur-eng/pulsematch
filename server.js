'use strict';
// PulseMatch — backend
//
// POST /api/session/init         { p1 }           → { sessionId, partnerToken }
// POST /api/partner/:token       { p2 }           → { ok, sessionId }
// GET  /api/session/:id/status                    → { ready, preview }
// GET  /api/results/:id                           → { chemistry }  (free)

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const https    = require('https');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Firestore init ────────────────────────────────────────────────────
let db = null;

function initFirestore() {
  const svcAcct = process.env.GCP_SERVICE_ACCOUNT;
  if (svcAcct) {
    // Explicit JSON key — used outside GCP (e.g. local dev, Railway)
    try {
      const credentials = JSON.parse(svcAcct);
      db = new Firestore({
        projectId:   credentials.project_id,
        databaseId:  process.env.FIRESTORE_DB || '(default)',
        credentials: {
          client_email: credentials.client_email,
          private_key:  credentials.private_key,
        },
      });
      console.log('🔥  Firestore connected (GCP_SERVICE_ACCOUNT)');
    } catch (e) {
      console.warn('⚠️   GCP_SERVICE_ACCOUNT JSON parse failed:', e.message);
    }
  } else {
    // Cloud Run / GCE / GKE — Application Default Credentials picked up automatically
    try {
      db = new Firestore({
        projectId:  process.env.GCP_PROJECT_ID,   // optional — auto-detected on Cloud Run
        databaseId: process.env.FIRESTORE_DB || '(default)',
      });
      console.log('🔥  Firestore connected (Application Default Credentials)');
    } catch (e) {
      console.warn('⚠️   Firestore init failed:', e.message);
    }
  }
}
initFirestore();

// ── Persist helpers ───────────────────────────────────────────────────
// Write the full session snapshot to Firestore (fire-and-forget)
function persistSession(sessionId, session) {
  if (!db) return;
  const doc = {
    sessionId,
    partnerToken:  session.partnerToken,
    createdAt:     session.createdAt,
    updatedAt:     Date.now(),
    p1:            session.p1   || null,
    p2:            session.p2   || null,
    chemistry:     session.chemistry || null,
    intake:        session.intake    || null,
    paid:   !!session.paid,
    paidAt: session.paidAt || null,
  };
  db.collection('sessions').doc(sessionId).set(doc, { merge: true })
    .catch(e => console.error('Firestore write error:', e.message));

  // Keep partnerToken → sessionId lookup doc in sync
  db.collection('partnerTokens').doc(session.partnerToken)
    .set({ sessionId, createdAt: session.createdAt }, { merge: true })
    .catch(e => console.error('Firestore partnerToken write error:', e.message));
}

// ── In-memory session store (fast cache for active sessions) ──────────
const sessions      = new Map();   // sessionId → session
const partnerTokens = new Map();   // partnerToken → sessionId

setInterval(() => {
  const cutoff = Date.now() - 7_200_000;   // 2-hour expiry
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      partnerTokens.delete(s.partnerToken);
      sessions.delete(id);
    }
  }
}, 300_000);

// ── Chemistry algorithm ───────────────────────────────────────────────
function computeChemistry(p1, p2) {
  const hrDelta = Math.abs(p1.hr - p2.hr);
  const hrSync  = Math.round(Math.max(0, 100 - hrDelta * 2.5));

  const avgHR   = (p1.hr + p2.hr) / 2;
  const arousal = Math.round(Math.min(100, Math.max(0, (avgHR - 62) * 3)));

  const coherence = Math.round(((p1.quality || 0.5) + (p2.quality || 0.5)) / 2 * 100);

  const raw   = hrSync*0.56 + arousal*0.26 + coherence*0.18;
  const score = Math.round(Math.min(99, Math.max(18, raw)));

  const tiers = [
    {
      min: 80, emoji: '🔥', label: 'Electric',
      tagline: 'Rare physiological resonance. Your bodies already know each other.',
      detail:  'Your heart rates converged and your HRV patterns showed the complementary antiphase coupling documented in established romantic pairs (Feldman, 2007). A large real-world speed-dating study found that HR + skin conductance synchrony — not smiles or eye contact — was the only reliable predictor of mutual attraction. Your numbers place you in that category.',
    },
    {
      min: 65, emoji: '💕', label: 'Strong Spark',
      tagline: 'Significant synchrony detected. Something real is here.',
      detail:  'Cardiac coupling at this level is consistent with the autonomic co-regulation seen in couples during positive interaction. Research on interpersonal physiological synchrony (IPS) shows this pattern correlates with empathy, relationship satisfaction, and prosocial behaviour — your nervous systems are already tuning in to each other.',
    },
    {
      min: 50, emoji: '✨', label: 'Promising',
      tagline: 'Your rhythms are finding each other. Let this breathe.',
      detail:  'Moderate HR synchrony detected. This is the level commonly observed between acquaintances with genuine interest — the ANS coupling is there but hasn\'t fully emerged yet. Studies show synchrony strengthens with physical proximity and time. The physiological groundwork is present.',
    },
    {
      min: 35, emoji: '🌱', label: 'Potential',
      tagline: 'The chemistry is quiet now. Sometimes the best ones take time.',
      detail:  'Lower spontaneous synchrony, but context matters — research shows first-meeting nerves, stress, and attachment style can suppress the signal. This is not absence of chemistry; it may simply mean your nervous systems haven\'t had time to regulate to each other yet.',
    },
    {
      min: 0, emoji: '🤍', label: 'Different Frequencies',
      tagline: 'Your rhythms diverge — but the heart has its own logic.',
      detail:  'Your autonomic patterns are currently out of phase. Research notes that HRV synchrony in couples is often antiphase (complementary, not matching) — so "different frequencies" isn\'t necessarily a barrier. Synchrony is dynamic and emerges most reliably during sustained interaction.',
    },
  ];

  const tier = tiers.find(t => score >= t.min);
  return {
    score, hrSync, arousal, coherence,
    emoji:   tier.emoji,
    label:   tier.label,
    tagline: tier.tagline,
    detail:  tier.detail,
    p1: { hr: p1.hr },
    p2: { hr: p2.hr },
  };
}

function addIntakeContext(chemistry, intake) {
  if (!intake) return chemistry;
  const rel  = intake.relationship || 'established';
  const prox = intake.proximity    || 'sameroom';

  const relNote = {
    established: `For an established couple, this level of synchrony is consistent with long-term co-regulation — the kind documented in studies where partners' HRs align even in silence (UC Davis, 2023).`,
    dating:      `For a couple still forming their bond, this synchrony is notable. Research shows HR coupling strengthens with emotional intimacy — this is an early signal of that process.`,
    justmet:     `For two people who just met, this synchrony is significant. The speed-dating literature (Prochazkova et al.) found HR coupling during first interactions is the strongest predictor of mutual attraction — better than smiles, eye contact, or self-report.`,
  }[rel] || '';

  const proxNote = prox === 'remote'
    ? ' Note: synchrony tends to be stronger with physical co-presence — your score across distance is particularly meaningful.'
    : '';

  return {
    ...chemistry,
    intake:  { name1: intake.name1||'Person 1', name2: intake.name2||'Person 2', relationship: rel, proximity: prox },
    context: `${chemistry.detail} ${relNote}${proxNote}`.trim(),
  };
}

// ── POST /api/session/init ────────────────────────────────────────────
app.post('/api/session/init', (req, res) => {
  const { p1 } = req.body;
  if (!p1?.hr) return res.status(400).json({ ok: false, error: 'Missing P1 scan data' });

  const sessionId    = crypto.randomBytes(20).toString('hex');
  const partnerToken = crypto.randomBytes(12).toString('hex');

  const session = {
    p1, p2: null, chemistry: null, intake: null,
    partnerToken, paid: false, createdAt: Date.now(), paidAt: null,
  };

  sessions.set(sessionId, session);
  partnerTokens.set(partnerToken, sessionId);
  persistSession(sessionId, session);

  console.log(`🆕  Session ${sessionId.slice(0,8)} — P1 HR=${p1.hr} token=${partnerToken.slice(0,8)}…`);
  res.json({ ok: true, sessionId, partnerToken });
});

// ── POST /api/partner/:token ──────────────────────────────────────────
app.post('/api/partner/:token', (req, res) => {
  const sessionId = partnerTokens.get(req.params.token);
  if (!sessionId) return res.status(404).json({ ok: false, error: 'Invalid or expired partner token' });

  const session = sessions.get(sessionId);
  if (!session)  return res.status(404).json({ ok: false, error: 'Session not found' });
  if (session.p2) return res.json({ ok: true, already: true, sessionId });

  const { p2 } = req.body;
  if (!p2?.hr) return res.status(400).json({ ok: false, error: 'Missing P2 scan data' });

  session.p2        = p2;
  session.chemistry = computeChemistry(session.p1, p2);
  persistSession(sessionId, session);

  console.log(`✅  Session ${sessionId.slice(0,8)} — P2 HR=${p2.hr} score=${session.chemistry.score} "${session.chemistry.label}"`);
  res.json({ ok: true, sessionId });
});

// ── GET /api/session/:id/status ───────────────────────────────────────
app.get('/api/session/:id/status', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  const ready   = session.chemistry !== null;
  const preview = ready ? {
    hint:  session.chemistry.score >= 65 ? 'high' : session.chemistry.score >= 45 ? 'medium' : 'low',
    emoji: session.chemistry.emoji,
  } : null;

  res.json({ ok: true, ready, preview, paid: !!session.paid });
});

// ── GET /api/results/:sessionId — free, no payment required ──────────
app.get('/api/results/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session)           return res.status(404).json({ ok: false, error: 'Session not found or expired' });
  if (!session.chemistry) return res.status(400).json({ ok: false, error: 'Both scans not complete yet' });
  res.json({ ok: true, chemistry: session.chemistry });
});

// ── Start servers ─────────────────────────────────────────────────────
const CERT = path.join(__dirname, 'cert.pem');
const KEY  = path.join(__dirname, 'key.pem');
const PORT       = parseInt(process.env.PORT       || '3001', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3444', 10);

console.log('\n💕  PulseMatch server starting…');
http.createServer(app).listen(PORT, () =>
  console.log(`   HTTP  → http://localhost:${PORT}`));

if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
  https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, app)
    .listen(HTTPS_PORT, () =>
      console.log(`   HTTPS → https://localhost:${HTTPS_PORT}`));
}

if (!db)
  console.log('   ⚠️  No Firestore — set GCP_SERVICE_ACCOUNT to enable persistence\n');
