// A car horn made with Web Audio: two detuned square waves (the classic
// two-note car horn) through a low-pass filter. Sounds while held.
export class Horn {
    constructor() {
        this.ctx = null;
        this.voice = null;
    }

    start() {
        if (this.voice) return;
        try {
            // Browsers only allow audio after a user gesture; a key press counts.
            this.ctx ??= new AudioContext();
            const ctx = this.ctx, t = ctx.currentTime;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 1800;
            filter.connect(gain).connect(ctx.destination);
            const oscs = [415, 523].map((f) => {
                const o = ctx.createOscillator();
                o.type = 'square';
                o.frequency.value = f;
                o.connect(filter);
                o.start(t);
                return o;
            });
            this.voice = { gain, oscs };
        } catch {
            this.voice = null; // no audio available: stay silent
        }
    }

    stop() {
        if (!this.voice) return;
        const { gain, oscs } = this.voice, t = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.04);
        for (const o of oscs) o.stop(t + 0.05);
        this.voice = null;
    }
}
