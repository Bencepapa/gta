import { v2, add, sub, mul, dot, cross, fromAngle, perp } from './vec.js';

// Every physical thing in the world is an oriented box:
// { body, halfL, halfW, radius, static? }. Static things have infinite mass.

export function corners(e) {
    if (e._corners) return e._corners;
    const { halfL: x, halfW: y, body } = e;
    const pts = [v2(x, y), v2(-x, y), v2(-x, -y), v2(x, -y)].map((p) => body.localToWorld(p));
    if (e.static) e._corners = pts; // static things never move
    return pts;
}

// Nothing to resolve between two things that are both standing still.
const resting = (b) =>
    b.mass === Infinity || (b.vel.x * b.vel.x + b.vel.y * b.vel.y < 1e-4 && Math.abs(b.angVel) < 1e-3);

function project(pts, axis) {
    let min = Infinity, max = -Infinity;
    for (const p of pts) {
        const d = dot(p, axis);
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return [min, max];
}

// Separating-axis test between two boxes. Returns { n, depth, point } with
// n pointing from A to B, or null if they don't overlap.
export function contact(A, B) {
    const ca = corners(A), cb = corners(B);
    let best = null;
    for (const [ref, cRef, cInc] of [[A, ca, cb], [B, cb, ca]]) {
        const f = fromAngle(ref.body.angle);
        for (const axis of [f, perp(f)]) {
            const [a0, a1] = project(ca, axis);
            const [b0, b1] = project(cb, axis);
            const depth = Math.min(a1, b1) - Math.max(a0, b0);
            if (depth <= 0) return null;
            if (!best || depth < best.depth) best = { depth, axis, ref, cRef, cInc };
        }
    }
    let n = best.axis;
    if (dot(sub(B.body.pos, A.body.pos), n) < 0) n = mul(n, -1);

    // Contact point: incident-box corners that are inside the reference box
    // along n, averaged (gives the edge midpoint for flat contacts).
    const into = best.ref === A ? n : mul(n, -1); // from reference toward incident
    const [, refMax] = project(best.cRef, into);
    let hits = best.cInc.filter((p) => dot(p, into) <= refMax + 1e-6);
    if (!hits.length) hits = best.cInc;
    const point = mul(hits.reduce(add, v2()), 1 / hits.length);
    return { n, depth: best.depth, point };
}

const SLOP = 0.01;
const CORRECTION = 0.8;
const RESTITUTION = 0.3;
const FRICTION = 0.35;

export function resolve(A, B, { n, depth, point }) {
    const a = A.body, b = B.body;
    const ima = 1 / a.mass, imb = 1 / b.mass;
    const iia = 1 / a.inertia, iib = 1 / b.inertia;
    if (ima + imb === 0) return;

    // Push apart, split by inverse mass.
    const c = (Math.max(depth - SLOP, 0) * CORRECTION) / (ima + imb);
    a.pos = sub(a.pos, mul(n, c * ima));
    b.pos = add(b.pos, mul(n, c * imb));

    const ra = sub(point, a.pos), rb = sub(point, b.pos);
    const relVel = () => sub(b.pointVelocity(point), a.pointVelocity(point));
    const vn = dot(relVel(), n);
    if (vn >= 0) return;

    const rna = cross(ra, n), rnb = cross(rb, n);
    const kn = ima + imb + rna * rna * iia + rnb * rnb * iib;
    const e = vn < -1 ? RESTITUTION : 0;
    const jn = (-(1 + e) * vn) / kn;
    a.applyImpulse(mul(n, -jn), point);
    b.applyImpulse(mul(n, jn), point);

    // Coulomb friction along the contact tangent.
    const t = perp(n);
    const vt = dot(relVel(), t);
    const rta = cross(ra, t), rtb = cross(rb, t);
    const kt = ima + imb + rta * rta * iia + rtb * rtb * iib;
    const jt = Math.max(-FRICTION * jn, Math.min(FRICTION * jn, -vt / kt));
    a.applyImpulse(mul(t, -jt), point);
    b.applyImpulse(mul(t, jt), point);
}

// Sort-and-sweep along x on bounding circles to find candidate pairs, then
// run a few resolution passes over just those pairs.
export function collideAll(dynamics, statics, iterations = 2) {
    const all = dynamics.concat(statics);
    for (const e of all) e._minX = e.body.pos.x - e.radius;
    all.sort((a, b) => a._minX - b._minX);

    const pairs = [];
    for (let i = 0; i < all.length; i++) {
        const A = all[i], maxX = A.body.pos.x + A.radius;
        for (let j = i + 1; j < all.length && all[j]._minX <= maxX; j++) {
            const B = all[j];
            if (resting(A.body) && resting(B.body)) continue;
            const dx = A.body.pos.x - B.body.pos.x, dy = A.body.pos.y - B.body.pos.y;
            const r = A.radius + B.radius;
            if (dx * dx + dy * dy <= r * r) pairs.push(A.static ? [B, A] : [A, B]);
        }
    }
    for (let it = 0; it < iterations; it++)
        for (const [A, B] of pairs) {
            const c = contact(A, B);
            if (c) resolve(A, B, c);
        }
}
