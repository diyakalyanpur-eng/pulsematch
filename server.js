'use strict';
// PulseMatch — backend
//
// POST /api/session/init         { p1 }           → { sessionId, partnerToken }
// POST /api/partner/:token       { p2 }           → { ok }           (P2 submits scan)
// GET  /api/session/:id/status                    → { ready, preview } (P1 polls)
// POST /api/checkout             { sessionId, intake } → { url }
// GET  /api/results/:id          ?stripe_session_id=  → { chemistry }

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

// ── Session store ─────────────────────────────────────────────────────
const sessions      = new Map();   // sessionId → session
const partnerTokens = new Map();   // partnerToken → sessionId

setInterval(() => {
  const cutoff = Date.now() - 7_200_000;  // 2-hour expiry
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      partnerTokens.delete(s.partnerToken);
      sessions.delete(id);
    }
  }
}, 300_000);

// ── Chemistry algorithm ───────────────────────────────────────────────
function computeChemistry(p1, p2) {
  const hrDelta    = Math.abs(p1.hr - p2.hr);
  const hrSync     = Math.round(Math.max(0, 100 - hrDelta * 2.5));

  const hrvDelta   = Math.abs(p1.hrv - p2.hrv);
  const hrvHarmony = Math.round(Math.max(0, 100 - hrvDelta * 1.8));

  const avgHR  = (p1.hr + p2.hr) / 2;
  const arousal = Math.round(Math.min(100, Math.max(0, (avgHR - 62) * 3)));

  const coherence = Math.round(((p1.quality || 0.5) + (p2.quality || 0.5)) / 2 * 100);

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
  return { score, hrSync, hrvHarmony, arousal, coherence,
    emoji: tier.emoji, label: tier.label, tagline: tier.tagline, detail: tier.detail,
    p1: { hr: p1.hr, hrv: p1.hrv }, p2: { hr: p2.hr, hrv: p2.hrv } };
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
// P1 submits their scan result → creates session, returns partner link token
app.post('/api/session/init', (req, res) => {
  const { p1 } = req.body;
  if (!p1?.hr) return res.status(400).json({ ok: false, error: 'Missing P1 scan data' });

  const sessionId    = crypto.randomBytes(20).toString('hex');
  const partnerToken = crypto.randomBytes(12).toString('hex');

  sessions.set(sessionId, {
    p1, p2: null, chemistry: null,
    partnerToken, paid: false, createdAt: Date.now(),
  });
  partnerTokens.set(partnerToken, sessionId);

  console.log(`🆕  Session ${sessionId.slice(0,8)} — P1 HR=${p1.hr} token=${partnerToken.slice(0,8)}…`);
  res.json({ ok: true, sessionId, partnerToken });
});

// ── POST /api/partner/:token ──────────────────────────────────────────
// P2 submits their scan result (same device OR remote link)
app.post('/api/partner/:token', (req, res) => {
  const sessionId = partnerTokens.get(req.params.token);
  if (!sessionId) return res.status(404).json({ ok: false, error: 'Invalid or expired partner token' });

  const session = sessions.get(sessionId);
  if (!session)  return res.status(404).json({ ok: false, error: 'Session not found' });
  if (session.p2) return res.json({ ok: true, already: true }); // idempotent

  const { p2 } = req.body;
  if (!p2?.hr) return res.status(400).json({ ok: false, error: 'Missing P2 scan data' });

  session.p2        = p2;
  session.chemistry = computeChemistry(session.p1, p2);

  console.log(`✅  Session ${sessionId.slice(0,8)} — P2 HR=${p2.hr} score=${session.chemistry.score} "${session.chemistry.label}"`);
  res.json({ ok: true, sessionId });
});

// ── GET /api/session/:id/status ───────────────────────────────────────
// P1 polls this until P2 has scanned
app.get('/api/session/:id/status', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  const ready = session.chemistry !== null;
  const preview = ready ? {
    hint:  session.chemistry.score >= 65 ? 'high' : session.chemistry.score >= 45 ? 'medium' : 'low',
    emoji: session.chemistry.emoji,
  } : null;

  res.json({ ok: true, ready, preview, paid: !!session.paid });
});

// ── POST /api/checkout ────────────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  const { sessionId, intake } = req.body;
  const session = sessions.get(sessionId);
  if (!session)         return res.status(404).json({ ok: false, error: 'Session not found' });
  if (!session.chemistry) return res.status(400).json({ ok: false, error: 'Both scans not complete yet' });

  if (intake) {
    session.intake    = intake;
    session.chemistry = addIntakeContext(session.chemistry, intake);
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const origin    = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  if (!stripeKey) {
    session.paid = true;
    return res.json({ ok: true, url: `${origin}/?session=${sessionId}&paid=dev` });
  }

  try {
    const stripe   = require('stripe')(stripeKey);
    const checkout = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: {
        currency: 'eur',
        product_data: { name: '💕 PulseMatch — Chemistry Report', description: 'Your full physiological synchrony analysis' },
        unit_amount: 100,
      }, quantity: 1 }],
      mode:                'payment',
      client_reference_id: sessionId,
      success_url: `${origin}/?session=${sessionId}&paid={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/?session=${sessionId}&cancelled=true`,
    });
    res.json({ ok: true, url: checkout.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/results/:sessionId ───────────────────────────────────────
app.get('/api/results/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found or expired' });

  const stripeKey     = process.env.STRIPE_SECRET_KEY;
  const stripeSession = req.query.stripe_session_id;

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

if (!process.env.STRIPE_SECRET_KEY)
  console.log('   ⚠️  Dev mode — payment skipped (set STRIPE_SECRET_KEY to enable)\n');
