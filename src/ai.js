import { v2, add, sub, mul, dot, cross, len, fromAngle, rot } from './vec.js';
import { nodePos, neighbours, LANE, PITCH, N, ROAD } from './city.js';
import { roadHeadings } from './assist.js';
import { STOP_LINE, nodeKey, axisOf, boxAt } from './junctions.js';

const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const unit = (a) => mul(a, 1 / len(a));
const right = (d) => v2(d.y, -d.x);

// Path following.
const CRUISE = 11;          // m/s on straights
const CORNER_ACCEL = 2.6;       // m/s² sideways acceleration allowed in a turn (cars)
const CORNER_ACCEL_HEAVY = 2.0; // ...for vehicles over HEAVY_MASS, which run wide if faster
const HEAVY_MASS = 3000;
const RIGHT_TURN_R = 6;     // m, preferred turn radius (tight, inside corner)
const LEFT_TURN_R = 10;     // m, preferred turn radius (crossing the junction)
const BEZIER_STEPS = 10;
const EXIT_ACCEL = 3;       // m/s² we let speed build up at from halfway round a turn

// Points every `step` metres along a polyline, starting from the point
// closest to p and covering `length` metres. Each has its arc distance s
// from that start and the path direction t there.
function samplePath(pts, p, length, step = 1) {
    let best = Infinity, bi = 0, bq = pts[0];
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], ab = sub(pts[i + 1], a);
        const t = clamp(dot(sub(p, a), ab) / dot(ab, ab), 0, 1);
        const q = add(a, mul(ab, t));
        const d = len(sub(p, q));
        if (d < best) { best = d; bi = i; bq = q; }
    }
    const out = [];
    let cur = bq, s = 0, i = bi, nextAt = 0;
    while (s <= length) {
        if (i >= pts.length - 1) { // run off the end: carry on straight
            const t = unit(sub(pts[pts.length - 1], pts[pts.length - 2]));
            out.push({ p: add(cur, mul(t, nextAt - s)), s: nextAt, t });
            nextAt += step;
            if (nextAt > length) break;
            continue;
        }
        const seg = sub(pts[i + 1], cur), l = len(seg);
        if (l < 1e-6) { i++; continue; }
        const t = mul(seg, 1 / l);
        while (nextAt <= s + l && nextAt <= length) {
            out.push({ p: add(cur, mul(t, nextAt - s)), s: nextAt, t });
            nextAt += step;
        }
        s += l;
        cur = pts[i + 1];
        i++;
    }
    return out;
}

// Closest point on a polyline, then `ahead` metres further along it.
// Returns the look-ahead point, the distance along the path from the
// closest point to the path's vertex `mark` (0 once past it), and `along`,
// the arc distance from the start of the path to the closest point.
function alongPath(pts, p, ahead, mark) {
    let best = Infinity, bi = 0, bq = pts[0];
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], ab = sub(pts[i + 1], a);
        const t = clamp(dot(sub(p, a), ab) / dot(ab, ab), 0, 1);
        const q = add(a, mul(ab, t));
        const d = len(sub(p, q));
        if (d < best) { best = d; bi = i; bq = q; }
    }
    let along = len(sub(bq, pts[bi]));
    for (let i = 0; i < bi; i++) along += len(sub(pts[i + 1], pts[i]));
    let toMark = 0;
    if (bi < mark) {
        toMark = len(sub(pts[bi + 1], bq));
        for (let i = bi + 1; i < mark; i++) toMark += len(sub(pts[i + 1], pts[i]));
    }
    let cur = bq, left = ahead;
    for (let i = bi; i < pts.length - 1; i++) {
        const l = len(sub(pts[i + 1], cur));
        if (l >= left) return { point: add(cur, mul(unit(sub(pts[i + 1], cur)), left)), toMark, offPath: best, along };
        left -= l;
        cur = pts[i + 1];
    }
    const n = pts.length;
    return { point: add(cur, mul(unit(sub(pts[n - 1], pts[n - 2])), left)), toMark, offPath: best, along };
}

// Tuning for getting unstuck.
const WAIT_LIMIT = 3;     // s to wait behind something that isn't moving
const STUCK_TIME = 2;     // s of trying to drive without making progress
const REVERSE_TIME = 1.8; // s to back up for (cut short if something is behind)
const DETOUR_DIST = 16;   // m to drive in the opposite lane to get around
const DETOUR_MAX = 6;     // s before giving up on the detour
const NO_PROGRESS = 0.6;  // m/s; slower than this while trying to move = no progress
const GIVE_UP = 3;        // failed attempts before turning round and going back
const WRONG_LANE_WAIT = 0.8; // s to wait facing oncoming traffic in the wrong lane before backing out

// Junction manners.
const DEFAULT_COURTESY = 0.25; // chance to give up our right, if the vehicle doesn't set one
const STALEMATE_WAIT = 1.5;    // s everyone has been waiting before someone may give up
const STALEMATE_MAX = 6;       // s after which someone in a stalemate always gives up
const COURTESY_MAX = 10;     // s to wait for them before taking our right back
const SIGNAL_DIST = 35;      // m before a junction to start indicating
const RULES_DIST = 30;       // m before the stop line where junction rules start to apply
// How long a driver will wait for a reason before inching out anyway.
// Red lights are never ignored.
// Driving into an occupied junction is what turns a wait into a gridlock,
// so 'junction busy' is the most patient, and never overridden at lights
// (the cycle always lets the cars inside clear).
const IMPATIENCE = { 'junction busy': 25, 'exit blocked': 10, 'give way': 20, 'give way (turning left)': 20, 'give way (right)': 20 };

// Drives a Car around the road grid on the right-hand lane, choosing a random
// direction at each junction. It produces the same controls a player would.
//
// States:
//   drive   - follow the lane, brake for things ahead
//   reverse - back out after waiting too long or failing to move
//   detour  - pull into the opposite lane for a moment to get around the obstacle
// After GIVE_UP failed attempts the road is treated as blocked: the car
// reverses its route and three-point-turns to go back the way it came.
export class Driver {
    constructor(car, from, to, rand) {
        Object.assign(this, { car, from, to, rand });
        this.next = this.pickNext();
        this.state = 'drive';
        this.timer = 0;     // time in current reverse/detour
        this.waited = 0;    // time spent waiting behind a stationary obstacle
        this.stuck = 0;     // time spent trying to move without moving
        this.attempts = 0;  // consecutive reverse attempts without getting going
        this.cruising = 0;  // time spent moving freely (resets attempts)
        this.side = 1;      // which way to swing the tail when reversing
        this.waiting = false;
        this.turningRound = false;
        this.lockRoute = 0;  // s during which reroute() is suppressed
        // Drivers differ in patience, so a knot of cars doesn't all back
        // out at the same moment.
        this.patience = 0.7 + rand() * 0.8;
        this.wrongLaneWait = 0;  // s spent stopped nose-to-nose in the wrong lane
        this.backToLane = false; // reversing to get back into our own lane
        this.holdReason = null;  // why we're stopped at a junction, if we are
        this.commitKey = null;   // junction we've committed to driving through
        this.courtesyKey = null; // junction where we already decided about giving way
        this.courtesy = null;    // { key, t } while letting others go first
        this.holdTime = 0;       // how long we've been held at the current junction
        this.stalemateRoll = 0;  // s since we last considered breaking a stalemate
        this.recklessKey = null; // junction where we decided whether to break the rules
        this.reckless = false;   // ignoring the rules at this junction
    }

    pickNext() {
        const options = neighbours(this.to).filter((n) => !same(n, this.from));
        return options[Math.floor(this.rand() * options.length)] ?? this.from;
    }

    // Point in the lane at the junction we are heading to. offset > 0 moves
    // it toward the opposite lane (used for detours).
    target(offset = 0) {
        const a = nodePos(this.from), b = nodePos(this.to);
        const d = mul(sub(b, a), 1 / len(sub(b, a)));
        return add(b, mul(v2(d.y, -d.x), LANE - offset));
    }

    // The lane path for the current segment and the junction at its end:
    // our lane up to the turn, a curve through the junction sized to the
    // vehicle's turning circle, then the lane of the next segment.
    // Right-hand traffic: right turns hug the inside corner, left turns
    // cross the junction on a wider curve.
    plan() {
        const F = nodePos(this.from), T = nodePos(this.to), X2 = nodePos(this.next);
        const d1 = unit(sub(T, F)), d2 = unit(sub(X2, T));
        const r1 = right(d1), r2 = right(d2);
        const start = add(F, mul(r1, LANE));
        const end = add(X2, mul(r2, LANE));
        const turn = cross(d1, d2); // > 0 left, < 0 right, 0 straight
        if (Math.abs(turn) < 0.5) {
            return { pts: [start, add(T, mul(r1, LANE)), end], mark: 1, radius: Infinity, T, d1, d2, exit: 0, turn: 0 };
        }
        const c = this.car.cfg;
        const minR = c.wheelbase / Math.tan(c.maxSteer);
        // The curve is a quadratic Bézier; its tightest point (the middle)
        // has a radius of about 0.71 x its leg length, so size the legs to
        // keep that within the vehicle's turning circle, with some margin.
        const radius = Math.max(turn < 0 ? RIGHT_TURN_R : LEFT_TURN_R, minR * 1.6);
        // A tight right turn on a wide curve would clip the pavement corner.
        // Like a real bus, line up a little closer to the centre line on the
        // way in (still inside our own lane) so the inside clears it; the
        // exit stays in the normal lane.
        let offIn = LANE;
        if (turn < 0) {
            const need = this.car.halfW + 1 + 0.354 * radius; // corner-to-curve clearance needed
            const kerb = ROAD / 2 - LANE;                      // lane line to kerb
            const shift = Math.sqrt(Math.max(0, need * need - kerb * kerb)) - kerb;
            offIn = LANE - clamp(shift, 0, LANE - this.car.halfW - 0.3);
        }
        const P = add(T, add(mul(r1, offIn), mul(r2, LANE))); // where the two lane lines cross
        const E = sub(P, mul(d1, radius)), X = add(P, mul(d2, radius));
        const curve = [];
        for (let i = 1; i < BEZIER_STEPS; i++) {
            const t = i / BEZIER_STEPS, u = 1 - t;
            curve.push(add(add(mul(E, u * u), mul(P, 2 * u * t)), mul(X, t * t)));
        }
        const pts = [start, E, ...curve, X, end];
        let curveStart = len(sub(E, start)), curveLen = 0;
        for (let i = 1; i < pts.length - 2; i++) curveLen += len(sub(pts[i + 1], pts[i]));
        return { pts, mark: 1, radius, T, d1, d2, exit: dot(sub(X, T), d2), turn: Math.sign(turn), curveStart, curveLen };
    }

    // Steering input to drive the rear axle through `point` (pure pursuit
    // on the bicycle model, so it adapts to each vehicle's wheelbase).
    pursue(point) {
        const b = this.car.body, c = this.car.cfg;
        const rear = sub(b.pos, mul(fromAngle(b.angle), c.wheelbase / 2));
        const l = rot(sub(point, rear), -b.angle);
        const alpha = Math.atan2(l.y, l.x);
        const wheel = Math.atan((2 * c.wheelbase * Math.sin(alpha)) / Math.max(len(l), 1));
        return { steer: clamp(wheel / c.maxSteer, -1, 1), alpha };
    }

    // Point `ahead` metres further along the current segment from the car,
    // shifted `offset` metres from our lane toward the opposite lane.
    lookahead(offset, ahead) {
        const a = nodePos(this.from), c = nodePos(this.to);
        const seg = len(sub(c, a)), dir = mul(sub(c, a), 1 / seg);
        const along = clamp(dot(sub(this.car.body.pos, a), dir) + ahead, 0, seg);
        return add(add(a, mul(dir, along)), mul(v2(dir.y, -dir.x), LANE - offset));
    }

    // Pick the road segment that best matches where the car is now facing,
    // so a car that got spun round or shoved off the road finds its way back
    // instead of trying to U-turn to its old route.
    reroute() {
        const b = this.car.body, f = fromAngle(b.angle);
        const ni = clamp(Math.round(b.pos.x / PITCH), 0, N), nj = clamp(Math.round(b.pos.y / PITCH), 0, N);
        const near = [ni, nj];
        let best = null, bestScore = -Infinity;
        for (const m of neighbours(near))
            for (const [from, to] of [[near, m], [m, near]]) {
                const a = nodePos(from), c = nodePos(to);
                const dir = mul(sub(c, a), 1 / len(sub(c, a)));
                const lane = add(c, mul(v2(dir.y, -dir.x), LANE));
                const ahead = rot(sub(lane, b.pos), -b.angle).x;
                if (ahead < 4) continue;
                const score = dot(dir, f) - len(sub(lane, b.pos)) / 200;
                if (score > bestScore) { bestScore = score; best = [from, to]; }
            }
        if (best) {
            [this.from, this.to] = best;
            this.next = this.pickNext();
        }
    }

    // What the junction controller needs to know about our approach to the
    // junction we're heading for. Called once per tick before controls().
    junctionAgent() {
        const car = this.car, b = car.body, c = car.cfg;
        const T = nodePos(this.to);
        const d1 = unit(sub(T, nodePos(this.from))), d2 = unit(sub(nodePos(this.next), T));
        const turn = cross(d1, d2);
        const fwd = Math.max(0, dot(b.vel, fromAngle(b.angle)));
        const decel = Math.min((c.brakeForce ?? c.engineForce) / c.mass, 9) * 0.8;
        const dist = dot(sub(T, b.pos), d1) - STOP_LINE - car.halfL;
        const key = nodeKey(this.to);
        this.agent = {
            car, node: this.to, arm: d1, move: turn > 0.5 ? 'L' : turn < -0.5 ? 'R' : 'S',
            dist, speed: fwd, stopDist: (fwd * fwd) / (2 * decel),
            committed: this.commitKey === key,
            // In the junction = committed and past the line, or really in it
            // (not just a nose over the line while giving way).
            inBox: (this.commitKey === key && dist < 0) || dist < -car.halfL,
            held: !!this.holdReason,
            courtesy: this.courtesy?.key === key,
        };
        // Remember the junction we just left: we may still be in its box.
        if (car.lastJunction && nodeKey(car.lastJunction.node) !== key) car.prevJunction = car.lastJunction;
        car.lastJunction = this.agent;
        return this.agent;
    }

    // Is a (nearly) stationary car sitting just past the junction in the lane
    // we're about to drive into?
    exitBlocked(others, plan) {
        // A box covering our exit lane, from the junction edge out to one
        // vehicle length (+2 m) — just our lane, not the oncoming one.
        const room = this.car.halfL * 2 + 2, r2 = right(plan.d2);
        for (const o of others) {
            if (o === this.car || o.kind !== 'car' || len(o.body.vel) >= 1) continue;
            const rel = sub(o.body.pos, plan.T);
            const along = dot(rel, plan.d2), lat = dot(rel, r2);
            if (along > ROAD / 2 - o.halfL && along < ROAD / 2 + room + o.halfL && Math.abs(lat - LANE) < 2.5) return true;
        }
        return false;
    }

    // Closest thing on the stretch of our planned path ahead (follows the
    // curve through a junction, so cars in other lanes or waiting at other
    // stop lines don't count even when our nose points at them mid-turn).
    // Same result shape as obstacle().
    pathObstacle(others, pts, reach, ignoreHeld = false) {
        const car = this.car, b = car.body;
        const samples = samplePath(pts, b.pos, reach + car.halfL + 4);
        const halfLane = car.halfW + 0.6;
        const far = reach + car.halfL * 2 + 6;
        let hit = null;
        for (const o of others) {
            if (o === car || (ignoreHeld && o.held)) continue;
            const rel = sub(o.body.pos, b.pos);
            if (Math.abs(rel.x) > far + o.radius || Math.abs(rel.y) > far + o.radius) continue;
            // Nearest path sample to the obstacle.
            let sp = null, bd = Infinity;
            for (const q of samples) {
                const d = len(sub(o.body.pos, q.p));
                if (d < bd) { bd = d; sp = q; }
            }
            if (!sp || bd > halfLane + o.radius + 1) continue;
            const fo = fromAngle(o.body.angle);
            const c = Math.abs(dot(fo, sp.t)), s = Math.abs(cross(fo, sp.t));
            const extX = c * o.halfL + s * o.halfW, extY = s * o.halfL + c * o.halfW;
            const d = sub(o.body.pos, sp.p);
            if (Math.abs(cross(sp.t, d)) >= halfLane + extY) continue;
            const along = sp.s + dot(sp.t, d);
            if (along <= 0) continue; // beside or behind us
            const gap = along - car.halfL - extX;
            if (gap > reach) continue;
            if (!hit || gap < hit.gap) hit = { o, gap, vLead: dot(o.body.vel, sp.t) };
        }
        return hit;
    }

    // Closest thing in a corridor in front of (dir = 1) or behind (dir = -1)
    // the car, within `reach` metres of our bumper.
    // Returns { o, gap, vLead }: bumper-to-bumper gap (m) and the obstacle's
    // speed along our heading (m/s), or null.
    obstacle(others, dir, reach, ignoreHeld = false) {
        const car = this.car, b = car.body;
        const f = fromAngle(b.angle);
        const halfLane = car.halfW + 0.6;
        let hit = null;
        for (const o of others) {
            if (o === car || (ignoreHeld && o.held)) continue;
            const rel = sub(o.body.pos, b.pos);
            const l = rot(rel, -b.angle);
            const x = l.x * dir;
            if (x <= 0 || x > car.halfL + o.radius + reach) continue;
            // Obstacle's extent along / across our heading.
            const fo = fromAngle(o.body.angle);
            const c = Math.abs(dot(fo, f)), s = Math.abs(cross(fo, f));
            const extX = c * o.halfL + s * o.halfW, extY = s * o.halfL + c * o.halfW;
            const gap = x - car.halfL - extX;
            // Things off the road (crates on the pavement, parked cars) only
            // matter when we're about to touch them.
            if (gap > 2 && roadHeadings(o.body.pos).length === 0) continue;
            if (Math.abs(l.y) >= halfLane + extY) continue;
            if (!hit || gap < hit.gap) hit = { o, gap, vLead: dot(o.body.vel, f) * dir };
        }
        return hit;
    }

    // Are we on a road (not in a junction), more than ~1 m into the lane for
    // the opposite direction?
    inWrongLane() {
        const b = this.car.body;
        if (boxAt(b.pos)) return false;
        const a = nodePos(this.from), d = unit(sub(nodePos(this.to), a));
        const lateral = dot(sub(b.pos, a), right(d)); // +LANE is our lane
        return lateral < -0.8 && dot(fromAngle(b.angle), d) > 0.5;
    }

    startReverse() {
        this.state = 'reverse';
        this.timer = 0;
        this.attempts++;
        // Reversing with the wheels to the right swings the nose left, toward
        // the opposite lane we'll detour through. Alternate on repeated
        // attempts in case that side is the problem.
        this.side = this.attempts % 2 ? -1 : 1;
        this.turningRound = this.attempts >= GIVE_UP;
        if (this.turningRound) {
            [this.from, this.to] = [this.to, this.from];
            this.next = this.pickNext();
            this.attempts = 0;
        }
    }

    controls(others, dt, junctions = null) {
        const b = this.car.body;
        const speed = len(b.vel);
        const fwd = dot(b.vel, fromAngle(b.angle));
        this.waiting = false;

        // Move on to the next segment once we're through the junction.
        let plan = this.plan();
        const through = plan.radius === Infinity
            ? dot(sub(b.pos, plan.T), plan.d1) > 0
            : dot(sub(b.pos, plan.T), plan.d2) > plan.exit - 0.5;
        if (through) {
            [this.from, this.to] = [this.to, this.next];
            this.next = this.pickNext();
            plan = this.plan();
        }

        // ---------- reversing out ----------
        if (this.state === 'reverse') {
            this.timer += dt;
            const local = rot(sub(this.target(), b.pos), -b.angle);
            const angle = Math.atan2(local.y, local.x);
            const behind = this.obstacle(others, -1, 1.5);
            const noRoom = this.timer > 0.6 && speed < 0.3;
            if (!this.backToLane && (this.timer > REVERSE_TIME + this.attempts * 0.4 + (this.turningRound ? 0.8 : 0) || behind || noRoom)) {
                this.timer = 0;
                this.stuck = 0;
                this.waited = 0;
                if (this.turningRound) {
                    // Finish the turn going forward; don't let reroute()
                    // point us straight back at the blockage meanwhile.
                    this.turningRound = false;
                    this.state = 'drive';
                    this.lockRoute = 5;
                    return { throttle: 0, steer: 0, handbrake: false };
                }
                this.reroute();
                this.state = 'detour';
                this.detourFrom = b.pos;
                this.stuck = 0;
                this.waited = 0;
            }
            if (this.backToLane && (this.timer > 1.6 || behind || noRoom)) {
                this.backToLane = false;
                this.state = 'drive';
                this.timer = 0;
                this.car.signal = null;
                return { throttle: 0, steer: 0, handbrake: false };
            }
            // Backing up, the nose turns opposite to the wheels: steer so the
            // nose swings toward the target, or swing the tail out if aligned.
            // Backing out of the wrong lane, swing the nose right, toward our lane.
            const steer = this.backToLane ? 1 : Math.abs(angle) > 0.25 ? clamp(-angle * 2, -1, 1) : this.side;
            this.car.aiWaiting = false;
            this.car.queued = false;
            this.car.held = false;
            this.holdReason = null;
            this.car.signal = 'hazard';
            return { throttle: -1, steer, handbrake: false };
        }

        // ---------- driving / detouring ----------
        let detour = false;
        if (this.state === 'detour') {
            this.timer += dt;
            const a = nodePos(this.from), dir = mul(sub(nodePos(this.to), a), 1 / PITCH);
            const progressed = dot(sub(b.pos, this.detourFrom), dir);
            if (progressed > DETOUR_DIST || this.timer > DETOUR_MAX) this.state = 'drive';
            else detour = true;
        }

        // Follow the lane path with a look-ahead that grows with speed and
        // vehicle length. Detouring: aim a short way ahead in the opposite
        // lane instead, so the car actually pulls out.
        const c = this.car.cfg;
        const lookDist = clamp(3 + 0.45 * Math.max(fwd, 0), 4, 12) + c.wheelbase * 0.4;
        const path = alongPath(plan.pts, b.pos, lookDist, plan.mark);
        const target = detour ? this.lookahead(2 * LANE, 10) : path.point;
        const { steer, alpha } = this.pursue(target);

        // Facing well away from the route (spun, shoved): pick a route that
        // fits the current heading rather than trying to turn around.
        this.lockRoute = Math.max(0, this.lockRoute - dt);
        if (Math.abs(alpha) > 1.9 && path.offPath > 6 && this.lockRoute === 0) this.reroute();

        // Speed: cruise, but be at corner speed by the time the curve starts,
        // braking at a comfortable rate for this vehicle. Slow right down if
        // we're well off the path or pointing away from it.
        const vCorner = Math.sqrt((c.mass > HEAVY_MASS ? CORNER_ACCEL_HEAVY : CORNER_ACCEL) * plan.radius);
        const decel0 = Math.min((c.brakeForce ?? c.engineForce) / c.mass, 9) * 0.8;
        const brake = Math.min(c.engineForce / c.mass, 6) * 0.5;
        let want = Math.min(CRUISE, Math.sqrt(vCorner * vCorner + 2 * brake * Math.max(0, path.toMark - 2)));
        // Halfway round a turn the hard part is over: build speed back up
        // smoothly for the rest of the curve and the exit. Heavy vehicles
        // wait until three-quarters round, or they swing wide on the exit.
        const from = c.mass > HEAVY_MASS ? 0.75 : 0.5;
        const pastHalf = plan.curveLen ? path.along - plan.curveStart - plan.curveLen * from : -1;
        if (pastHalf > 0) want = Math.min(CRUISE, Math.sqrt(vCorner * vCorner + 2 * EXIT_ACCEL * pastHalf));
        else if (Math.abs(alpha) > 0.6) want = Math.min(want, 4);
        if (detour) want = Math.min(want, 6);

        // Junction rules: stop at the line for a red light, a give-way sign,
        // or (turning left) oncoming traffic. Once we can no longer stop
        // comfortably before the line, we're committed and go through.
        this.holdReason = null;
        if (junctions && this.agent && this.state === 'drive' && !detour && this.agent.dist < Math.max(RULES_DIST, this.agent.stopDist + 10)) {
            const ag = this.agent;
            const key = nodeKey(ag.node);
            if (this.courtesy && this.courtesy.key !== key) this.courtesy = null;

            // Sometimes give up our right to the cars waiting for us: flash
            // the headlights twice and wait for them to go. How likely
            // depends on the vehicle (buses and lorries are more patient).
            const chance = c.courtesy ?? DEFAULT_COURTESY;
            const giveUp = () => {
                this.courtesy = { key, t: 0 };
                ag.courtesy = true;
                this.car.flash = 0.9; // two quick flashes
            };
            if (!this.courtesy && this.courtesyKey !== key && junctions.canGiveWay(ag)) {
                this.courtesyKey = key;
                if (this.rand() < chance) giveUp();
            }
            // Stalemate at an unsigned junction: we're waiting for the car
            // on our right while the car on our left waits for us. Every
            // second someone may give up; after a while someone always does.
            if (!this.courtesy && this.holdReason === null && this.lastHold === 'give way (right)' &&
                this.holdTime > STALEMATE_WAIT && junctions.waitedOnBy(ag) && !junctions.anyCourtesy(ag)) {
                this.stalemateRoll += dt;
                if (this.stalemateRoll >= 1) {
                    this.stalemateRoll = 0;
                    // Everyone's deadline differs a little so they don't all give up at once.
                    if (this.rand() < chance || this.holdTime > STALEMATE_MAX + (this.car.id % 5) * 0.7) giveUp();
                }
            }

            let reason = null;
            const J = junctions.nodes.get(key);
            // Some drivers (sports cars, mostly) now and then just ignore the rules.
            if (this.recklessKey !== key) {
                this.recklessKey = key;
                this.reckless = this.rand() < (c.ruleBreak ?? 0);
            }
            const minor = J && J.type === 'priority' && axisOf(ag.arm) !== J.mainAxis;
            // Side road or turning left: approach slowly enough to stop at
            // the line, so we don't commit before seeing who's coming.
            if (!this.reckless && !ag.committed && ag.dist > 0 && J && J.type !== 'corner' && (minor || ag.move === 'L'))
                want = Math.min(want, 4 + 0.3 * ag.dist);
            if (this.courtesy) {
                this.courtesy.t += dt;
                if (this.courtesy.t > COURTESY_MAX || (this.courtesy.t > 1.5 && junctions.clearAfterCourtesy(ag))) {
                    this.courtesy = null;           // take our right back
                    this.commitKey = key;
                } else reason = 'letting others go';
            } else reason = this.reckless ? null : junctions.decide(ag);
            // Don't block the box: wait at the line if our exit is jammed.
            if (!reason && !ag.committed && ag.dist > -1.5 && J && J.type !== 'corner' && this.exitBlocked(others, plan)) reason = 'exit blocked';

            const patientHere = reason === 'red light' || (reason === 'junction busy' && J?.type === 'lights');
            if (reason && !patientHere && this.holdTime > (IMPATIENCE[reason] ?? Infinity) * this.patience) {
                reason = null;                    // waited long enough: go
                this.commitKey = key;
            }
            if (reason) {
                this.holdReason = reason;
                const room = Math.max(0, ag.dist - 1.2); // aim a little short: braking lags slightly
                want = Math.min(want, Math.sqrt(2 * decel0 * room));
                if (want < 1) want = 0;
            } else if (ag.dist < ag.stopDist + 1) this.commitKey = nodeKey(ag.node);
        }
        this.car.held = !!this.holdReason;
        this.holdTime = this.holdReason && fwd < 0.5 ? this.holdTime + dt : 0;
        this.lastHold = this.holdReason;

        // Keep a safe distance from whatever is ahead, like adaptive cruise:
        // the speed we can have now and still stop (or match the lead's
        // speed) before the gap shrinks below a safe minimum. The look-ahead
        // covers our actual stopping distance, so faster = looks further.
        const decel = decel0;
        const stopDist = (fwd * fwd) / (2 * decel);
        // Inside a junction, cars held at their stop lines are in their own
        // lanes, not in our path, even if our nose points at them mid-turn.
        const inJunction = (this.agent && this.agent.dist < 0) || !!(this.car.prevJunction && boxAt(b.pos));
        // Look along our planned path; fall back to straight ahead when we're
        // detouring or have been knocked well off the path.
        const ahead = detour
            ? this.obstacle(others, 1, 2.5, inJunction)
            : path.offPath > 2.5
                ? this.obstacle(others, 1, Math.max(6, stopDist + 6), inJunction)
                : this.pathObstacle(others, plan.pts, Math.max(6, stopDist + 6), inJunction);
        if (ahead) {
            const vLead = Math.max(0, ahead.vLead);
            const safeGap = 1.5 + 0.8 * vLead; // standstill gap + ~0.8 s time gap
            const room = Math.max(0, ahead.gap - safeGap);
            want = Math.min(want, vLead + Math.sqrt(2 * decel * room));
            if (want < 1.5) {
                want = 0;
                this.waiting = true;
                // A stationary obstacle counts toward giving up and backing
                // out. Queued behind another waiting AI car: be patient, but
                // not forever (two cars can wait on each other at a junction).
                if (ahead.o.queued) { /* queue at a junction: just wait */ }
                else if (len(ahead.o.body.vel) < 0.5) this.waited += dt * (ahead.o.aiWaiting ? 0.35 : 1);
                else this.waited = Math.max(0, this.waited - dt);
            } else this.waited = Math.max(0, this.waited - dt * 2);
        } else this.waited = Math.max(0, this.waited - dt * 2);

        // Trying to move but not getting anywhere (wedged against a wall,
        // a house, or a car we don't "see").
        if (want > 1 && speed < NO_PROGRESS) this.stuck += dt;
        else this.stuck = Math.max(0, this.stuck - dt * 2);

        if (speed > 4) {
            this.cruising += dt;
            if (this.cruising > 2) this.attempts = 0;
        } else this.cruising = 0;

        // Stopped in the wrong lane, either nose-to-nose with oncoming traffic
        // or waiting at a junction (red light, give way)? We're the one in
        // the wrong: back out into our own lane after a moment, then carry on.
        const headOn = ahead && dot(fromAngle(ahead.o.body.angle), fromAngle(b.angle)) < -0.5;
        const stoppedWrong = (this.waiting && headOn) || !!this.holdReason;
        if (!detour && stoppedWrong && fwd < 0.5 && this.inWrongLane()) this.wrongLaneWait += dt;
        else this.wrongLaneWait = 0;
        if (this.wrongLaneWait > WRONG_LANE_WAIT) {
            this.wrongLaneWait = 0;
            this.waited = 0;
            this.stuck = 0;
            this.state = 'reverse';
            this.timer = 0;
            this.backToLane = true;
        }

        if (this.waited > WAIT_LIMIT * this.patience || this.stuck > STUCK_TIME) {
            this.waited = 0;
            this.stuck = 0;
            this.startReverse();
        }
        // Lights: hazards while blocked by something that isn't moving or
        // wedged; otherwise indicate the turn coming up at the junction.
        const blocked = this.waited > 0.3 || this.stuck > 0.3;
        if (blocked && !detour) this.car.signal = 'hazard';
        else if (detour) this.car.signal = 'left';
        else if (plan.turn && (path.toMark < SIGNAL_DIST)) this.car.signal = plan.turn > 0 ? 'left' : 'right';
        else this.car.signal = null;
        if (this.car.flash > 0) this.car.flash -= dt;

        this.car.aiWaiting = this.waiting;
        // Waiting in a queue for a junction (not inside one) is just waiting.
        this.car.queued = this.car.held || (!inJunction && !!ahead && this.waiting && !!ahead.o.queued);

        return {
            // Gentle on the throttle, firm on the brake: anything more than a
            // little too fast gets real brake pressure, ~1.7 m/s over is full.
            throttle: want >= fwd ? clamp((want - fwd) * 0.4, 0, 1) : clamp((want - fwd) * 0.6, -1, 0),
            // Still rolling backwards (e.g. just finished reversing): the
            // steering works the other way round until we're going forward.
            steer: steer * (fwd < -0.3 ? -1 : 1),
            handbrake: false,
        };
    }
}
