/**
 * Runtime-generated WebAudio (spec 3.2): engine tone follows speed, wind
 * rises with hover, boost punches a filtered saw, bumps thump, gate whooshes.
 * No audio files → no licensing questions, ~2 kB of code.
 */

export interface GameAudio {
  setEngine(speedRatio: number, boost: boolean, hover: boolean): void;
  bump(strength: number): void;
  gate(): void;
  cheer(): void;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export function createAudio(): GameAudio {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);

  // ---- engine: two detuned saws through a lowpass ----
  const osc1 = ctx.createOscillator();
  osc1.type = "sawtooth";
  const osc2 = ctx.createOscillator();
  osc2.type = "sawtooth";
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0.0001;
  const engineFilter = ctx.createBiquadFilter();
  engineFilter.type = "lowpass";
  engineFilter.frequency.value = 500;
  const enginePan = ctx.createStereoPanner();
  osc1.connect(engineGain);
  osc2.connect(engineGain);
  engineGain.connect(engineFilter);
  engineFilter.connect(enginePan);
  enginePan.connect(master);
  osc1.start();
  osc2.start();

  // ---- wind (hover): filtered noise ----
  const noiseLen = ctx.sampleRate * 1.5;
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < noiseLen; i++) {
    // brown-ish noise drifting slowly
    last = (last + (Math.random() * 2 - 1) * 0.04) * 0.98;
    data[i] = last * 3;
  }
  const wind = ctx.createBufferSource();
  wind.buffer = noiseBuf;
  wind.loop = true;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.0001;
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = "bandpass";
  windFilter.frequency.value = 700;
  windFilter.Q.value = 0.6;
  wind.connect(windFilter);
  windFilter.connect(windGain);
  windGain.connect(master);
  wind.start();

  return {
    setEngine(speedRatio, boost, hover) {
      const t = ctx.currentTime;
      const base = 58 + speedRatio * 210; // Hz
      osc1.frequency.setTargetAtTime(base, t, 0.06);
      osc2.frequency.setTargetAtTime(base * 1.007 + 2, t, 0.06);
      engineFilter.frequency.setTargetAtTime(360 + speedRatio * 2600 + (boost ? 900 : 0), t, 0.08);
      engineGain.gain.setTargetAtTime(0.045 + speedRatio * 0.11 + (boost ? 0.05 : 0), t, 0.1);
      windGain.gain.setTargetAtTime(hover ? 0.1 : speedRatio * 0.04, t, 0.15);
      windFilter.frequency.setTargetAtTime(hover ? 900 : 500 + speedRatio * 700, t, 0.2);
    },
    bump(strength) {
      const t = ctx.currentTime;
      const s = Math.max(0.08, Math.min(1, strength));
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.14);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5 * s, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.18);

      const n = ctx.createBufferSource();
      n.buffer = noiseBuf;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.28 * s, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      const nf = ctx.createBiquadFilter();
      nf.type = "highpass";
      nf.frequency.value = 900;
      n.connect(nf);
      nf.connect(ng);
      ng.connect(master);
      n.start(t);
      n.stop(t + 0.12);
    },
    gate() {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(300, t);
      o.frequency.exponentialRampToValueAtTime(1400, t + 0.28);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.36);
    },
    cheer() {
      const t = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1450;
      band.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      noise.connect(band);
      band.connect(g);
      g.connect(master);
      noise.start(t);
      noise.stop(t + 1.35);
      for (const [frequency, delay] of [[520, 0], [660, 0.08], [780, 0.16]] as const) {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = "triangle";
        o.frequency.setValueAtTime(frequency, t + delay);
        og.gain.setValueAtTime(0.0001, t + delay);
        og.gain.exponentialRampToValueAtTime(0.12, t + delay + 0.04);
        og.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.65);
        o.connect(og);
        og.connect(master);
        o.start(t + delay);
        o.stop(t + delay + 0.7);
      }
    },
    suspend() {
      void ctx.suspend();
    },
    resume() {
      void ctx.resume();
    },
    dispose() {
      void ctx.close();
    },
  };
}
