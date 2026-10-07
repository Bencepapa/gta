import { v2, add, sub, mul, cross, rot } from './vec.js';

// Classical 2D rigid body: accumulate force + torque, then integrate.
export class Body {
    constructor({ mass, inertia }) {
        this.mass = mass;
        this.inertia = inertia;
        this.pos = v2();
        this.vel = v2();
        this.angle = 0;
        this.angVel = 0;
        this.force = v2();
        this.torque = 0;
    }

    localToWorld(p) {
        return add(this.pos, rot(p, this.angle));
    }

    // Velocity of a world-space point fixed to the body: v + w x r.
    pointVelocity(p) {
        const r = sub(p, this.pos);
        return v2(this.vel.x - this.angVel * r.y, this.vel.y + this.angVel * r.x);
    }

    applyForce(f, at = this.pos) {
        this.force = add(this.force, f);
        this.torque += cross(sub(at, this.pos), f);
    }

    applyImpulse(j, at = this.pos) {
        this.vel = add(this.vel, mul(j, 1 / this.mass));
        this.angVel += cross(sub(at, this.pos), j) / this.inertia;
    }

    // Semi-implicit (symplectic) Euler.
    step(dt) {
        this.vel = add(this.vel, mul(this.force, dt / this.mass));
        this.angVel += (this.torque / this.inertia) * dt;
        this.pos = add(this.pos, mul(this.vel, dt));
        this.angle += this.angVel * dt;
        this.force = v2();
        this.torque = 0;
    }
}
