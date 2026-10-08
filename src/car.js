import { v2, mul, add, dot, fromAngle, perp } from './vec.js';
import { Body } from './body.js';
import { PRESETS } from './vehicles.js';

// The "GTA1-style" car: a rigid body pushed by an engine force at its centre,
// with each tyre acting as a velocity-proportional damper. Rolling damping is
// weak, sideways damping is strong. Steering a front wheel rotates its damping
// axes, and because that force acts off-centre it produces the turning torque.
export const CAR_DEFAULTS = PRESETS.original;

let nextId = 1;

export class Car {
    constructor(cfg = {}) {
        this.id = nextId++;
        this.body = new Body({ mass: 1, inertia: 1 });
        this.gripLoss = 0; // 0 = full rear grip, 1 = handbrake fully applied
        this.configure({ ...CAR_DEFAULTS, ...cfg });
    }

    // Apply a (possibly partial) config. Keeps position and motion.
    configure(cfg) {
        this.cfg = { ...this.cfg, ...cfg };
        const c = this.cfg;
        this.body.mass = c.mass;
        this.body.inertia = (c.mass * (c.length ** 2 + c.width ** 2)) / 12;
        this.halfL = c.length / 2;
        this.halfW = c.width / 2;
        this.radius = Math.hypot(this.halfL, this.halfW);
        this.kind = 'car';
        this.color = c.color;
        const wx = c.wheelbase / 2, wy = c.track / 2;
        const old = this.wheels;
        this.wheels = [
            { local: v2(wx, wy), front: true },
            { local: v2(wx, -wy), front: true },
            { local: v2(-wx, wy), front: false },
            { local: v2(-wx, -wy), front: false },
        ].map((w, i) => ({ ...w, steer: 0, skidding: false, world: old?.[i]?.world ?? v2() }));
    }

    // controls: { throttle: -1..1, steer: -1..1 (+ = left), handbrake: bool,
    //             brake?: 0..1 (foot brake: can bring the car to rest and hold it) }
    update(controls, dt) {
        this.input = controls;
        const c = this.cfg, b = this.body;
        const fwd = fromAngle(b.angle);
        const vFwd = dot(b.vel, fwd);

        // Handbrake bites instantly, releases over gripRecoveryTime.
        this.gripLoss = controls.handbrake ? 1 : Math.max(0, this.gripLoss - dt / c.gripRecoveryTime);

        // Throttle against the direction of travel brakes, with brakeForce
        // (or the engine force if a vehicle has none, as in the original).
        // Negative throttle only becomes a (weaker) reverse once stopped.
        let throttle = controls.throttle;
        const braking = (throttle < 0 && vFwd > 0.3) || (throttle > 0 && vFwd < -0.3);
        let force = c.engineForce;
        if (braking) force = c.brakeForce ?? c.engineForce;
        else if (throttle < 0 && vFwd <= 0) throttle *= c.reverseScale;
        // Optional limiter: fade drive out just below the cap.
        if (throttle > 0 && c.maxSpeedKmh > 0) {
            const vMax = c.maxSpeedKmh / 3.6;
            throttle *= Math.min(1, Math.max(0, (vMax - vFwd) / (0.02 * vMax)));
        }
        b.applyForce(mul(fwd, throttle * force));

        // Foot brake: opposes rolling up to brakeForce, but never more than
        // it takes to stop this step, so it can hold the car at a standstill
        // instead of pushing it the other way.
        if (controls.brake > 0) {
            const stop = (-vFwd * c.mass) / dt;
            const max = (c.brakeForce ?? c.engineForce) * controls.brake;
            b.applyForce(mul(fwd, Math.max(-max, Math.min(max, stop))));
        }

        for (const w of this.wheels) {
            w.steer = w.front ? controls.steer * c.maxSteer : 0;
            w.world = b.localToWorld(w.local);
            const vel = b.pointVelocity(w.world);
            const roll = fromAngle(b.angle + w.steer);
            const side = perp(roll);
            const vRoll = dot(vel, roll);
            const vSide = dot(vel, side);

            let rollK = c.rollingDamping;
            let sideK = c.lateralDamping;
            if (!w.front) {
                if (controls.handbrake) rollK *= c.handbrakeRollingMul;
                sideK *= 1 - this.gripLoss * (1 - c.handbrakeLateralMul);
                const s = Math.abs(vSide);
                w.skidding = s > (w.skidding ? c.skidOff : c.skidOn);
            }

            const f = add(mul(roll, -rollK * vRoll), mul(side, -sideK * vSide));
            b.applyForce(f, w.world);
        }

        b.step(dt);
    }
}
