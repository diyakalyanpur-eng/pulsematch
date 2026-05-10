// rPPG Lite — HR + HRV extraction for PulseMatch
// Face mode only. Outputs: HR (BPM) and HRV RMSSD (ms).
// Based on the same pipeline as AiSteth rPPG v2 but stripped to essentials.

export class RPPGLite {
  constructor(videoElement) {
    this.video  = videoElement;
    this.canvas = document.createElement('canvas');
    this.canvas.width  = 160;
    this.canvas.height = 120;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.fs        = 30;    // fps
    this.windowSec = 30;    // rolling buffer
    this.stepMs    = 2000;  // estimate every 2 s

    this.buffer  = [];
    this.hr      = 72;
    this.hrv     = 45;
    this.quality = 0;

    this._emaHR  = 72;
    this._emaHRV = 45;
    this._prevLum    = null;
    this._interval   = null;
    this._lastEst    = 0;
    this._startTime  = null;

    // (hr, hrv, quality, secondsLeft) => void
    this.onUpdate = null;
  }

  start() {
    this._startTime = performance.now();
    this._interval  = setInterval(() => this._sample(), 1000 / this.fs);
  }

  stop() { clearInterval(this._interval); }

  // ── Sample one frame ─────────────────────────────────────
  _sample() {
    if (this.video.readyState < 2) return;
    this.ctx.drawImage(this.video, 0, 0, 160, 120);

    // Multi-ROI: forehead + left cheek + right cheek
    const rois = [
      this.ctx.getImageData(48,  8, 64, 30).data,
      this.ctx.getImageData(10, 50, 45, 35).data,
      this.ctx.getImageData(105,50, 45, 35).data,
    ];

    let r = 0, g = 0, b = 0, count = 0;
    for (const d of rois) {
      for (let i = 0; i < d.length; i += 4) {
        const ri = d[i], gi = d[i+1], bi = d[i+2];
        // Simple skin filter (works well for mid tones)
        if (ri > bi && gi > bi && ri > 40 && ri < 240) {
          r += ri; g += gi; b += bi; count++;
        }
      }
    }

    // Fallback: use all pixels if skin filter rejects too many
    if (count < 150) {
      r = 0; g = 0; b = 0; count = 0;
      for (const d of rois) {
        count += d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]; g += d[i+1]; b += d[i+2];
        }
      }
    }

    if (count === 0) return;
    const rm = r/count, gm = g/count, bm = b/count;
    const lum = 0.299*rm + 0.587*gm + 0.114*bm;

    // Motion artifact rejection: >4% luminance jump → drop frame
    if (this._prevLum !== null) {
      const ms = Math.abs(lum - this._prevLum) / (this._prevLum + 1);
      if (ms > 0.04) { this._prevLum = lum; return; }
    }
    this._prevLum = lum;

    this.buffer.push({ t: performance.now(), r: rm, g: gm, b: bm });

    // Trim buffer to windowSec
    const cutoff = performance.now() - this.windowSec * 1000;
    while (this.buffer.length > 0 && this.buffer[0].t < cutoff) this.buffer.shift();

    const now = performance.now();
    if (this.buffer.length >= this.fs * 10 && now - this._lastEst >= this.stepMs) {
      this._lastEst = now;
      this._estimate();
    }
  }

  // ── Windowed CHROM (de Haan & Jeanne 2013) ───────────────
  _chromWindowed(buf) {
    const N = 32, out = [];
    for (let s = 0; s + N <= buf.length; s += N) {
      const win = buf.slice(s, s + N);
      let mr = 0, mg = 0, mb = 0;
      for (const x of win) { mr += x.r; mg += x.g; mb += x.b; }
      mr /= N; mg /= N; mb /= N;
      if (mr < 5 || mg < 5 || mb < 5) {
        for (let i = 0; i < N; i++) out.push(0);
        continue;
      }
      const Xs = win.map(x => 3*(x.r/mr) - 2*(x.g/mg));
      const Ys = win.map(x => 1.5*(x.r/mr) + (x.g/mg) - 1.5*(x.b/mb));
      const sX = this._std(Xs), sY = this._std(Ys);
      const a  = sY > 1e-9 ? sX/sY : 1;
      out.push(...Xs.map((x, i) => x - a*Ys[i]));
    }
    return out;
  }

  // ── Zero-phase bandpass 0.7–3.5 Hz ───────────────────────
  _bandpass(signal, fLow = 0.7, fHigh = 3.5) {
    const n    = signal.length;
    const nfft = Math.pow(2, Math.ceil(Math.log2(n)));
    const re   = new Float64Array(nfft);
    const im   = new Float64Array(nfft);
    for (let i = 0; i < n; i++) re[i] = signal[i];
    this._fft(re, im);
    for (let k = 0; k < nfft; k++) {
      const f  = k * this.fs / nfft;
      const fm = (nfft - k) * this.fs / nfft;
      if (!((f >= fLow && f <= fHigh) || (fm >= fLow && fm <= fHigh))) {
        re[k] = 0; im[k] = 0;
      }
    }
    for (let i = 0; i < nfft; i++) im[i] = -im[i];
    this._fft(re, im);
    return Array.from({ length: n }, (_, i) => re[i] / nfft);
  }

  // ── 512-pt Welch, 75% overlap, parabolic interpolation ───
  _welchBPM(signal) {
    const n = signal.length, segLen = 512, step = 128;
    if (n < segLen) return { bpm: this._emaHR, quality: 0 };

    const hann = new Float64Array(segLen);
    for (let i = 0; i < segLen; i++)
      hann[i] = 0.5 * (1 - Math.cos(2*Math.PI*i/(segLen-1)));

    const psd  = new Float64Array(segLen);
    let   nSeg = 0;
    for (let s = n - segLen; s >= 0 && nSeg < 8; s -= step) {
      const re = new Float64Array(segLen);
      const im = new Float64Array(segLen);
      for (let i = 0; i < segLen; i++) re[i] = signal[s+i] * hann[i];
      this._fft(re, im);
      for (let k = 0; k < segLen/2; k++) psd[k] += re[k]**2 + im[k]**2;
      nSeg++;
    }
    if (nSeg === 0) return { bpm: this._emaHR, quality: 0 };
    for (let k = 0; k < segLen/2; k++) psd[k] /= nSeg;

    let bestK = -1, bestP = 0, totalP = 0, bandBins = 0;
    for (let k = 1; k < segLen/2; k++) {
      const f = k * this.fs / segLen;
      if (f < 0.7 || f > 3.5) continue;
      totalP += psd[k]; bandBins++;
      if (psd[k] > bestP) { bestP = psd[k]; bestK = k; }
    }
    if (bestK < 1) return { bpm: this._emaHR, quality: 0 };

    const p0 = psd[bestK-1], p1 = psd[bestK], p2 = psd[bestK+1] ?? 0;
    const denom    = p0 - 2*p1 + p2;
    const delta    = denom !== 0 ? 0.5*(p0-p2)/denom : 0;
    const refinedK = bestK + Math.max(-0.5, Math.min(0.5, delta));
    const bpm      = refinedK * this.fs / segLen * 60;

    const meanBandP = bandBins > 0 ? totalP/bandBins : 1;
    const snr       = meanBandP > 0 ? bestP/meanBandP : 0;
    const quality   = Math.min(1, snr/12);

    return { bpm, quality };
  }

  // ── HRV: RMSSD from IBI peak detection ───────────────────
  _computeHRV(filtered, bpmGuess) {
    const minDist = Math.max(5, Math.round(this.fs * 55 / bpmGuess));

    const tryDir = (s) => {
      const mx = Math.max(...s);
      if (mx < 1e-6) return null;
      const thr = 0.28 * mx;
      const pk  = [];
      for (let i = minDist; i < s.length - minDist; i++) {
        if (s[i] < thr) continue;
        let ok = true;
        for (let k = i - minDist; k <= i + minDist; k++) {
          if (k !== i && s[k] >= s[i]) { ok = false; break; }
        }
        if (ok) pk.push(i);
      }
      if (pk.length < 3) return null;
      const ibis = pk.slice(1).map((p, i) => (p - pk[i]) / this.fs * 1000);
      const avg  = ibis.reduce((a,b) => a+b, 0) / ibis.length;
      if (60000/avg < bpmGuess*0.70 || 60000/avg > bpmGuess*1.30) return null;
      return ibis;
    };

    const ibis = tryDir(filtered) ?? tryDir(filtered.map(v => -v));
    if (!ibis || ibis.length < 2) return null;

    const diffs = ibis.slice(1).map((v, i) => v - ibis[i]);
    const rmssd = Math.sqrt(diffs.reduce((s,d) => s+d*d, 0) / diffs.length);
    return Math.max(8, Math.min(120, Math.round(rmssd)));
  }

  // ── Cooley-Tukey in-place FFT ─────────────────────────────
  _fft(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2*Math.PI/len;
      const wR = Math.cos(ang), wI = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cR = 1, cI = 0;
        for (let k = 0; k < len/2; k++) {
          const uR = re[i+k],      uI = im[i+k];
          const vR = re[i+k+len/2]*cR - im[i+k+len/2]*cI;
          const vI = re[i+k+len/2]*cI + im[i+k+len/2]*cR;
          re[i+k]       = uR+vR; im[i+k]       = uI+vI;
          re[i+k+len/2] = uR-vR; im[i+k+len/2] = uI-vI;
          [cR, cI] = [cR*wR-cI*wI, cR*wI+cI*wR];
        }
      }
    }
  }

  _std(a)  { const m = this._mean(a); return Math.sqrt(a.reduce((s,v) => s+(v-m)**2,0)/a.length); }
  _mean(a) { return a.reduce((s,v) => s+v, 0) / a.length; }

  // ── Main estimate ─────────────────────────────────────────
  _estimate() {
    const chrom = this._chromWindowed(this.buffer);
    if (chrom.length < 256) return;

    const filtered           = this._bandpass(chrom);
    const { bpm: raw, quality } = this._welchBPM(filtered);
    this.quality = quality;

    const alpha = quality > 0.6 ? 0.40 : quality > 0.35 ? 0.25 : 0.08;
    const w     = Math.abs(raw - this._emaHR) > 25 ? 0.08 : alpha;
    this._emaHR = this._emaHR*(1-w) + raw*w;
    this.hr     = Math.round(Math.max(40, Math.min(200, this._emaHR)));

    if (quality > 0.28) {
      const rmssd = this._computeHRV(filtered, this.hr);
      if (rmssd !== null) {
        this._emaHRV = this._emaHRV*0.75 + rmssd*0.25;
        this.hrv     = Math.round(this._emaHRV);
      }
    }

    const elapsed  = (performance.now() - this._startTime) / 1000;
    const secsLeft = Math.max(0, 30 - elapsed);
    if (this.onUpdate) this.onUpdate(this.hr, this.hrv, quality, secsLeft);
  }
}
