import { dot, cross, fromAngle } from './vec.js';
import { PITCH, ROAD, N } from './city.js';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Road axes available at a point: grid roads run along x (heading 0) and y (heading π/2).
export function roadHeadings(p) {
    const onLine = (v) => {
        const i = Math.round(v / PITCH);
        return i >= 0 && i <= N && Math.abs(v - i * PITCH) <= ROAD / 2;
    };
    const inCity = (v) => v >= -ROAD / 2 && v <= N * PITCH + ROAD / 2;
    const out = [];
    if (onLine(p.y) && inCity(p.x)) out.push(0);
    if (onLine(p.x) && inCity(p.y)) out.push(Math.PI / 2);
    return out;
}

// Driver aid: when the car is nearly lined up with the road and the player
// isn't deliberately steering, add a small steering input that lines it up
// exactly. Short taps are softened and treated as nudges; holding the key
// longer than tapTime hands full control back to the player.
//
// It only ever produces a steering input, so the car physics is untouched.
export class SteerAssist {
    // options: { assist, assistAngle (deg), assistStrength (0..1), tapTime (s), tapScale (0..1) }
    constructor(options) {
        this.o = options;
        this.held = 0;   // how long the current steer direction has been held
        this.dir = 0;
        this.active = false;
        this.error = 0;  // last heading error to the road, rad
    }

    apply(car, input, dt) {
        const dir = Math.sign(input.steer);
        this.held = dir === 0 ? 0 : dir === this.dir ? this.held + dt : dt;
        this.dir = dir;
        this.active = false;

        const o = this.o, b = car.body, c = car.cfg;
        if (!o.assist || input.handbrake) return input;
        const f = fromAngle(b.angle);
        const vFwd = dot(b.vel, f);
        const vSide = cross(f, b.vel);
        if (vFwd < 3 || Math.abs(vSide) > 2) return input; // slow, reversing or sliding

        let err = null;
        for (const h of roadHeadings(b.pos))
            for (const a of [h, h + Math.PI]) {
                const e = wrap(a - b.angle);
                if (err === null || Math.abs(e) < Math.abs(err)) err = e;
            }
        if (err === null || Math.abs(err) > (o.assistAngle * Math.PI) / 180) return input;
        this.error = err;

        if (dir !== 0) {
            if (this.held > o.tapTime) return input; // deliberate steering
            this.active = true;
            return { ...input, steer: input.steer * o.tapScale };
        }

        // Aim for a yaw rate proportional to the error, convert that to a
        // wheel angle with the bicycle model, and damp the remaining yaw.
        const s = o.assistStrength;
        const yawWant = clamp(err * 3 * s, -0.8, 0.8);
        const wheel = Math.atan((yawWant * c.wheelbase) / vFwd);
        const steer = wheel / c.maxSteer + (yawWant - b.angVel) * 0.25;
        this.active = true;
        return { ...input, steer: clamp(steer, -0.6 * s, 0.6 * s) };
    }
}

// Pressing the other way when going slowly stops the car rather than
// flipping straight into reverse; keep holding and it drives off the other
// way after a moment. With no throttle at a near standstill, the foot brake
// holds the car so it doesn't creep.
export class BrakeAssist {
    static STOP_SPEED = 2;      // m/s (~7 km/h)
    static REVERSE_DELAY = 0.4; // s at a standstill before driving off the other way

    constructor() {
        this.dir = 0;  // throttle direction we're braking to a stop with
        this.held = 0; // s spent at a standstill with that key still held
    }

    apply(car, input, dt) {
        const { throttle } = input;
        const vFwd = dot(car.body.vel, fromAngle(car.body.angle));
        if (throttle !== this.dir) { this.dir = 0; this.held = 0; } // key released or changed
        if (throttle !== 0 && vFwd * throttle < 0 && Math.abs(vFwd) < BrakeAssist.STOP_SPEED) this.dir = throttle;
        if (this.dir !== 0) {
            if (Math.abs(vFwd) < 0.3) this.held += dt;
            if (this.held < BrakeAssist.REVERSE_DELAY) return { ...input, throttle: 0, brake: 1 };
            this.dir = 0; // held long enough: off we go the other way
        }
        if (throttle === 0 && Math.abs(vFwd) < 0.5) return { ...input, brake: 1 };
        return input;
    }
}
