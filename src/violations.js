import { v2, sub, dot, len, fromAngle } from './vec.js';
import { PITCH, ROAD, LANE, N } from './city.js';
import { axisOf, nodeKey, conflicts, boxAt } from './junctions.js';

// Spots drivers breaking the rules, and has the AI drivers who can see it
// flash their headlights at them (one long flash).
//
//   - running a red light
//   - not giving way (cutting in at a give-way sign, or ignoring the
//     right-hand rule at an unsigned junction)
//   - driving on the wrong side of the road toward oncoming traffic
//   - sitting at a green light with the junction free, holding up the queue

const LONG_FLASH = 1.3;   // s the headlights stay on
const COOLDOWN = 6;       // s before the same driver flashes again
const SEE_DIST = 45;      // m a witness can see
const SEE_ANGLE = 0.2;    // cos of the half-angle of the witness's view (~78°, includes the corner of the eye)
const RED_GRACE = 0.8;    // s after the light turns red that crossing still counts as amber
const GREEN_IDLE = 2.5;   // s sitting still at a free green before it's rude

export class Violations {
    constructor(junctions) {
        this.j = junctions;
        this.prev = new Map();       // car -> { k, dist }
        this.idleAtGreen = new Map(); // car -> s
        this.lastForPlayer = null;   // { text, who, t } for the HUD
    }

    update(dt, cars, agents, player, isAI) {
        for (const c of cars) if (c.flashLong > 0) c.flashLong -= dt;
        const byCar = new Map();
        for (const a of agents) if (!(a.inBox && a.dist === -1)) byCar.set(a.car, a);

        for (const [car, a] of byCar) {
            const k = nodeKey(a.node), J = this.j.nodes.get(k), p = this.prev.get(car);
            const others = (this.j.byNode.get(k) ?? []).filter((b) => b.car !== car);

            // Crossing the stop line just now?
            if (J && p && p.k === k && p.dist > 0 && a.dist <= 0 && !p.committed) {
                if (J.type === 'lights' && this.j.light(J, axisOf(a.arm)) === 'red' && this.j.redFor(J, axisOf(a.arm)) > RED_GRACE)
                    this.report(car, 'ran a red light', cars, player, isAI);
                else if (J.type === 'priority' && axisOf(a.arm) !== J.mainAxis) {
                    const cut = others.find((b) => axisOf(b.arm) === J.mainAxis && !b.courtesy && !b.inBox &&
                        b.speed > 1 && b.dist / b.speed < 2.5 && conflicts(a, b));
                    if (cut) this.report(car, "didn't give way", cars, player, isAI, [cut.car]);
                } else if (J.type === 'equal') {
                    const fromRight = v2(-a.arm.y, a.arm.x);
                    const cut = others.find((b) => dot(b.arm, fromRight) > 0.5 && !b.courtesy && !b.inBox &&
                        b.speed > 1 && b.dist / b.speed < 2.5 && conflicts(a, b));
                    if (cut) this.report(car, "ignored the car on its right", cars, player, isAI, [cut.car]);
                }
            }
            this.prev.set(car, { k, dist: a.dist, committed: a.committed && isAI(car) });

            // Sitting at a free green light holding people up.
            const idle = J && J.type === 'lights' && !a.held && a.dist > -1.5 && a.dist < 4 &&
                a.speed < 0.3 && this.j.light(J, axisOf(a.arm)) === 'green' && !others.some((b) => b.inBox);
            const t = idle ? (this.idleAtGreen.get(car) ?? 0) + dt : 0;
            this.idleAtGreen.set(car, t);
            if (t > GREEN_IDLE) {
                const behind = cars.filter((w) => w !== car && isAI(w) && sameLaneBehind(car, w, a.arm));
                if (behind.length) this.report(car, 'is sitting at a green light', cars, player, isAI, behind);
            }
        }

        // Wrong side of the road, toward oncoming traffic.
        for (const car of cars) {
            const wrong = wrongWay(car);
            if (!wrong) continue;
            const oncoming = cars.filter((w) => w !== car && isAI(w) && headOn(car, w, wrong));
            if (oncoming.length) this.report(car, 'is driving on the wrong side', cars, player, isAI, oncoming);
        }
    }

    // Witnesses flash; by default any AI driver nearby who's looking at it.
    report(violator, what, cars, player, isAI, witnesses = null) {
        const list = witnesses ?? cars.filter((w) => w !== violator && isAI(w) && sees(w, violator));
        let flashed = null;
        for (const w of list) {
            if (w === violator || !isAI(w) || (w.flashCooldown ?? 0) > this.j.t) continue;
            w.flashLong = LONG_FLASH;
            w.flashCooldown = this.j.t + COOLDOWN;
            flashed ??= w;
        }
        if (flashed && violator === player)
            this.lastForPlayer = { text: `${flashed.cfg.name} flashed you: you ${what.replace(/^is /, 'are ')}`, t: this.j.t };
    }
}

// Is the violator within sight, in front of the witness?
function sees(w, v) {
    const d = sub(v.body.pos, w.body.pos), dist = len(d);
    return dist < SEE_DIST && dist > 0.1 && dot(d, fromAngle(w.body.angle)) / dist > SEE_ANGLE;
}

// w is just behind car, in the same lane, facing the same way.
function sameLaneBehind(car, w, arm) {
    const d = sub(car.body.pos, w.body.pos);
    const along = dot(d, arm), lat = Math.abs(d.x * arm.y - d.y * arm.x);
    return along > 0 && along < 25 && lat < 2.5 && dot(fromAngle(w.body.angle), arm) > 0.7;
}

// On a road (not in a junction), moving along it on the left-hand side?
// Returns the direction of travel if so.
function wrongWay(car) {
    const b = car.body, speed = len(b.vel);
    if (speed < 3 || boxAt(b.pos)) return null;
    const d = Math.abs(b.vel.x) > Math.abs(b.vel.y) ? v2(Math.sign(b.vel.x), 0) : v2(0, Math.sign(b.vel.y));
    // Centre line of the road we're on (perpendicular coordinate is a multiple of PITCH).
    const perp = d.x ? b.pos.y : b.pos.x;
    const k = Math.round(perp / PITCH);
    if (k < 0 || k > N || Math.abs(perp - k * PITCH) > ROAD / 2) return null;
    const right = v2(d.y, -d.x);
    const lateral = d.x ? (b.pos.y - k * PITCH) * right.y : (b.pos.x - k * PITCH) * right.x;
    return lateral < -0.8 ? d : null; // more than ~1 m into the oncoming lane
}

// w is ahead of car in the lane car is wrongly in, coming toward it.
function headOn(car, w, d) {
    const rel = sub(w.body.pos, car.body.pos);
    const along = dot(rel, d), lat = Math.abs(rel.x * d.y - rel.y * d.x);
    return along > 0 && along < 50 && lat < LANE && dot(fromAngle(w.body.angle), d) < -0.7;
}
