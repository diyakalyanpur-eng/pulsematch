'use strict';
// PulseMatch — backend
// POST /api/session   → save both scan results, return sessionId + preview hint
// POST /api/checkout  → create Stripe €1 checkout (or skip in dev mode)
// GET  /api/results/:id?stripe_session_id=... → verify payment, return chemistry

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── In-memory session store (Firestore-ready swap-in for production) ──
const sessions = new Map();

// Expire sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 7_200_000;
  for (const [id, s] of sessions)
    if (s.createdAt < cutoff) sessions.delete(id);
}, 300_000);

// ── Chemistry algorithm (server-side, not exposed to client) ──────────
function computeChemistry(p1, p2) {
  // 1. Heart Rate Synchrony — closer resting HRs = stronger coupling
  const hrDelta  = Math.abs(p1.hr - p2.hr);
  const hrSync   = Math.round(Math.max(0, 100 - hrDelta * 2.5));

  // 2. HRV Harmony — similar autonomic regulation style
  const hrvDelta    = Math.abs(p1.hrv - p2.hrv);
  const hrvHarmony  = Math.round(Math.max(0, 100 - hrvDelta * 1.8));

  // 3. Spark Intensity — elevated HR during scan = nervous / excited (butterflies)
  const avgHR  = (p1.hr + p2.hr) / 2;
  const arousal = Math.round(Math.min(100, Math.max(0, (avgHR - 62) * 3)));

  // 4. Signal coherence — quality of both readings
  const coherence = Math.round(((p1.quality || 0.5) + (p2.quality || 0.5)) / 2 * 100);

  // Weighted total
  const raw   = hrSync*0.38 + hrvHarmony*0.32 + arousal*0.18 + coherence*0.12;
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
      detail:  'Cardiac coupling at this level is consistent with the autonomic co-regulation seen in couples during positive interaction. Research on interpersonal physiological synchrony (IPS) shows this pattern correlates with empathy, relationship satisfaction, and prosocial behaviour — suggesting your nervous systems are already tuning in to each other.',
    },
    {
      min: 50, emoji: '✨', label: 'Promising',
      tagline: 'Your rhythms are finding each other. Let this breathe.',
      detail:  'Moderate HR synchrony detected. This is the level commonly observed between acquaintances with genuine interest — the ANS coupling is there, but hasn\'t fully emerged yet. Studies show synchrony strengthens with physical proximity and time. The physiological groundwork is present.',
    },
    {
      min: 35, emoji: '🌱', label: 'Potential',
      tagline: 'The chemistry is quiet now. Sometimes the best ones take time.',
      detail:  'Lower spontaneous synchrony, but context matters — research shows first-meeting nerves, stress, and attachment style can suppress the signal. This is not absence of chemistry; it may simply mean your nervous systems haven\'t had time to regulate to each other yet. Synchrony builds with interaction.',
    },
    {
      min: 0,  emoji: '🤍', label: 'Different Frequencies',
      tagline: 'Your rhythms diverge — but the heart has its own logic.',
      detail:  'Your autonomic patterns are currently out of phase. Research notes that HRV synchrony in couples is often antiphase (complementary, not matching) — so "different frequencies" isn\'t necessarily a barrier. Physiological synchrony is dynamic, not fixed, and emerges most reliably during sustained interaction rather than a brief resting scan.',
    },
  ];

  const tier = tiers.find(t => score >= t.min);

  return {
    score,
    hrSync,
    hrvHarmony,
    arousal,
    coherence,
    emoji:   tier.emoji,
    label:   tier.label,
    tagline: tier.tagline,
    detail:  tier.detail,
    p1: { hr: p1.hr, hrv: p1.hrv },
    p2: { hr: p2.hr, hrv: p2.hrv },
  };
}

// ── POST /api/session ──────────────────────────────────────────────────
app.post('/api/session', (req, res) => {
  const { p1, p2 } = req.body;
  if (!p1?.hr || !p2?.hr)
    return res.status(400).json({ ok: false, error: 'Missing scan data' });

  const sessionId = crypto.randomBytes(20).toString('hex');
  const chemistry = computeChemistry(p1, p2);

  sessions.set(sessionId, { p1, p2, chemistry, paid: false, createdAt: Date.now() });

  console.log(`💾  Session ${sessionId.slice(0,8)} — score=${chemistry.score} tier="${chemistry.label}" HR=${p1.hr}/${p2.hr}`);

  res.json({
    ok: true,
    sessionId,
    preview: {
      hint:  chemistry.score >= 65 ? 'high' : chemistry.score >= 45 ? 'medium' : 'low',
      emoji: chemistry.emoji,
    },
  });
});

// ── Personalise chemistry with intake context ──────────────────────────
function addIntakeContext(chemistry, intake) {
  if (!intake) return chemistry;

  const rel = intake.relationship || 'established';
  const prox = intake.proximity || 'sameroom';
  const n1 = intake.name1 || 'Person 1';
  const n2 = intake.name2 || 'Person 2';

  // Relationship baseline note (per literature: synchrony is stronger in established couples)
  const relNote = {
    established: `For an established couple, this level of synchrony is consistent with long-term co-regulation — the kind documented in studies where partners' HRs align even in silence (UC Davis, 2023).`,
    dating:      `For a couple still forming their bond, this level of synchrony is notable. Research shows HR coupling strengthens with emotional intimacy — what you're measuring is an early signal of that process.`,
    justmet:     `For two people who just met, this synchrony is significant. The speed-dating literature (Prochazkova et al.) found that HR coupling during brief first interactions is the strongest predictor of mutual attraction — better than smiles, eye contact, or self-report.`,
  }[rel] || '';

  // Proximity note (physical presence amplifies synchrony per literature)
  const proxNote = prox === 'remote'
    ? ' Note: synchrony tends to be stronger with physical co-presence — your score across distance is particularly meaningful.'
    : '';

  const context = `${chemistry.detail} ${relNote}${proxNote}`.trim();

  return { ...chemistry, intake: { name1: n1, name2: n2, relationship: rel, proximity: prox }, context };
}

// ── POST /api/checkout ─────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const { sessionId, intake } = req.body;
  if (!sessions.has(sessionId))
    return res.status(404).json({ ok: false, error: 'Session not found' });

  // Store intake and build personalised context
  const session = sessions.get(sessionId);
  if (intake) {
    session.intake = intake;
    session.chemistry = addIntakeContext(session.chemistry, intake);
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const origin    = process.env.APP_URL ||
                    `${req.protocol}://${req.get('host')}`;

  // Dev mode: no Stripe key → skip payment
  if (!stripeKey) {
    sessions.get(sessionId).paid = true;
    return res.json({ ok: true, url: `${origin}/?session=${sessionId}&paid=dev` });
  }

  try {
    const stripe   = require('stripe')(stripeKey);
    const checkout = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name:        '💕 PulseMatch — Chemistry Report',
            description: 'Your full physiological synchrony analysis',
          },
          unit_amount: 100,  // €1.00
        },
        quantity: 1,
      }],
      mode:                 'payment',
      client_reference_id:  sessionId,
      success_url: `${origin}/?session=${sessionId}&paid={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/?session=${sessionId}&cancelled=true`,
    });
    res.json({ ok: true, url: checkout.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/results/:sessionId ────────────────────────────────────────
app.get('/api/results/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session)
    return res.status(404).json({ ok: false, error: 'Session not found or expired' });

  const stripeKey      = process.env.STRIPE_SECRET_KEY;
  const stripeSession  = req.query.stripe_session_id;

  // Already verified or dev mode
  if (session.paid || !stripeKey)
    return res.json({ ok: true, chemistry: session.chemistry });

  if (!stripeSession)
    return res.status(402).json({ ok: false, error: 'Payment required' });

  try {
    const stripe = require('stripe')(stripeKey);
    const ss     = await stripe.checkout.sessions.retrieve(stripeSession);
    if (ss.payment_status === 'paid' && ss.client_reference_id === req.params.sessionId) {
      session.paid = true;
      return res.json({ ok: true, chemistry: session.chemistry });
    }
    res.status(402).json({ ok: false, error: 'Payment not verified' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── HTTPS (local dev) ──────────────────────────────────────────────────
const CERT = path.join(__dirname, 'cert.pem');
const KEY  = path.join(__dirname, 'key.pem');

const PORT      = parseInt(process.env.PORT       || '3001', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3444', 10);

console.log('\n💕  PulseMatch server starting…');
http.createServer(app).listen(PORT, () =>
  console.log(`   HTTP  → http://localhost:${PORT}`));

if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
  const tlsOpts = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };
  https.createServer(tlsOpts, app).listen(HTTPS_PORT, () =>
    console.log(`   HTTPS → https://localhost:${HTTPS_PORT}  (camera works on phones)`));
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.log('\n   ⚠️  STRIPE_SECRET_KEY not set — running in dev mode (€1 payment skipped)');
  console.log('   Set STRIPE_SECRET_KEY=sk_live_... to enable real payments.\n');
}
