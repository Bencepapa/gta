import { v2, dot } from './vec.js';
import { PITCH, ROAD, N, nodePos, neighbours } from './city.js';

// Junction control: traffic lights at the busiest crossings, priority-road
// signs at most others, and a few unsigned junctions where the right-hand
// rule applies (give way to traffic coming from your right). AI drivers ask
// decide() whether they may enter.
//
// Main (priority) roads: horizontal road MAIN_ROWS[k] runs along y = j*PITCH,
// vertical road MAIN_COLS[k] along x = i*PITCH. Where two main roads cross,
// and at a few extra junctions, there are traffic lights.
export const MAIN_ROWS = [2];
export const MAIN_COLS = [3];
const EXTRA_LIGHTS = [[1, 4], [4, 1]];

export const STOP_LINE = ROAD / 2 + 0.5; // stop line distance from junction centre

// Light cycle (s): horizontal green, amber, all-red, vertical green, amber, all-red.
const GREEN = 9, AMBER = 2, ALL_RED = 1.5;
const CYCLE = 2 * (GREEN + AMBER + ALL_RED);

export const axisOf = (d) => (Math.abs(d.x) > Math.abs(d.y) ? 'h' : 'v');
export const nodeKey = (n) => n[0] + ',' + n[1];

export class Junctions {
    constructor() {
        this.t = 0;
        this.nodes = new Map();
        for (let i = 0; i <= N; i++)
            for (let j = 0; j <= N; j++) {
                const arms = neighbours([i, j]).length;
                const onRow = MAIN_ROWS.includes(j), onCol = MAIN_COLS.includes(i);
                let type = 'priority', mainAxis;
                if (arms < 3) type = 'corner';
                else if ((onRow && onCol) || EXTRA_LIGHTS.some(([a, b]) => a === i && b === j)) type = 'lights';
                // Some quiet interior junctions of two minor roads have no signs.
                else if (!onRow && !onCol && i > 0 && j > 0 && i < N && j < N && (i + j) % 2 === 0) type = 'equal';
                if (onRow && !onCol) mainAxis = 'h';
                else if (onCol && !onRow) mainAxis = 'v';
                // Two minor roads: the road that carries on straight (the
                // perimeter at T-junctions) has priority; otherwise alternate.
                else if (i === 0 || i === N) mainAxis = 'v';
                else if (j === 0 || j === N) mainAxis = 'h';
                else mainAxis = (i + j) % 2 ? 'h' : 'v';
                this.nodes.set(nodeKey([i, j]), {
                    i, j, pos: nodePos([i, j]), type, mainAxis,
                    offset: ((i * 7 + j * 13) % 10) * 2.3, // stagger the lights
                });
            }
        this.byNode = new Map();
    }

    step(dt) { this.t += dt; }

    light(J, axis) {
        const t = (this.t + J.offset) % CYCLE;
        const start = axis === 'h' ? 0 : GREEN + AMBER + ALL_RED;
        const u = (t - start + CYCLE) % CYCLE;
        return u < GREEN ? 'green' : u < GREEN + AMBER ? 'amber' : 'red';
    }

    // Seconds since the light for this axis turned red (0 if it isn't red).
    redFor(J, axis) {
        const t = (this.t + J.offset) % CYCLE;
        const start = axis === 'h' ? 0 : GREEN + AMBER + ALL_RED;
        const u = (t - start + CYCLE) % CYCLE;
        return u >= GREEN + AMBER ? u - GREEN - AMBER : 0;
    }

    // agents: { car, node: [i, j], arm (unit travel direction into the
    // junction), move: 'S' | 'L' | 'R', dist (front bumper to stop line, m;
    // < 0 once past it), speed, stopDist, committed, inBox }
    setAgents(agents) {
        this.byNode.clear();
        for (const a of agents) {
            const k = nodeKey(a.node);
            if (!this.byNode.has(k)) this.byNode.set(k, []);
            this.byNode.get(k).push(a);
        }
    }

    // Is this priority-road car close enough to keep the junction busy?
    reserves(b) {
        return b.dist < Math.max(25, b.speed * 4) && b.dist > -ROAD;
    }

    // May this car give up its right here? Someone must be waiting for it:
    // - priority junction: we're the only priority car keeping it busy and a
    //   side-road car is waiting;
    // - unsigned junction: the car on our left is waiting for us.
    canGiveWay(a) {
        const J = this.nodes.get(nodeKey(a.node));
        if (!J || a.committed || a.inBox || a.dist > 18 || a.speed > 8) return false;
        const others = (this.byNode.get(nodeKey(a.node)) ?? []).filter((b) => b.car !== a.car);
        if (J.type === 'priority') {
            if (axisOf(a.arm) !== J.mainAxis || a.dist < 1) return false;
            if (others.some((b) => axisOf(b.arm) === J.mainAxis && !b.courtesy && (b.inBox || this.reserves(b)))) return false;
            return others.some((b) => axisOf(b.arm) !== J.mainAxis && b.held && b.dist < 4);
        }
        if (J.type === 'equal') return this.waitedOnBy(a);
        return false;
    }

    // Has anyone at this junction already given up their right? (One is
    // enough to break a stalemate; if everyone did, nobody would go.)
    anyCourtesy(a) {
        return (this.byNode.get(nodeKey(a.node)) ?? []).some((b) => b.car !== a.car && b.courtesy);
    }

    // Unsigned junction: is the car to our left waiting for us?
    waitedOnBy(a) {
        const left = v2(a.arm.y, -a.arm.x); // travel direction of traffic coming from our left
        return (this.byNode.get(nodeKey(a.node)) ?? []).some((b) =>
            b.car !== a.car && b.held && b.dist < 4 && dot(b.arm, left) > 0.5);
    }

    // After giving way: wait until the junction has cleared of the cars we let go.
    clearAfterCourtesy(a) {
        const others = (this.byNode.get(nodeKey(a.node)) ?? []).filter((b) => b.car !== a.car);
        return !others.some((b) => b.inBox || (!b.held && b.dist < 4 && b.speed > 0.3 && dot(b.arm, a.arm) < 0.5));
    }

    // null = go; otherwise the reason to stop at the line.
    decide(a) {
        const J = this.nodes.get(nodeKey(a.node));
        if (!J || J.type === 'corner' || a.committed || a.inBox) return null;
        const others = (this.byNode.get(nodeKey(a.node)) ?? []).filter((b) => b.car !== a.car);
        const axis = axisOf(a.arm);

        if (J.type === 'lights') {
            const l = this.light(J, axis);
            // Amber: stop if we comfortably can, otherwise carry on through.
            if (l === 'red' || (l === 'amber' && a.dist > a.stopDist)) return 'red light';
        } else if (J.type === 'equal') {
            // Right-hand rule: give way to anyone approaching from our right
            // whose path meets ours, even if they're waiting too (that's a
            // stalemate, which someone breaks by giving up their right).
            const fromRight = v2(-a.arm.y, a.arm.x); // their travel direction
            for (const b of others)
                if (dot(b.arm, fromRight) > 0.5 && !b.courtesy && conflicts(a, b) &&
                    (b.inBox || (b.dist < Math.max(15, b.speed * 3) && b.dist > -ROAD)))
                    return 'give way (right)';
        } else if (axis !== J.mainAxis) {
            // Side road: a priority-road car approaching makes the junction
            // busy for anything whose path meets it. (A priority car that has
            // given up its right doesn't count.)
            for (const b of others)
                if (axisOf(b.arm) === J.mainAxis && !b.courtesy && conflicts(a, b) && (b.inBox || this.reserves(b)))
                    return 'give way';
        }

        if (a.move === 'L')
            for (const b of others) {
                if (dot(b.arm, a.arm) > -0.5 || b.courtesy) continue; // oncoming only
                if (b.move === 'L') {
                    // Two opposing left turns would crowd each other: whoever
                    // is committed or closer to the line takes the junction.
                    if (b.held && !b.committed) continue;
                    const first = b.committed || b.inBox || b.dist < a.dist - 0.5 ||
                        (Math.abs(b.dist - a.dist) <= 0.5 && b.car.id < a.car.id);
                    if (first && b.dist < 20) return 'junction busy';
                    continue;
                }
                // Oncoming straight or right turn: give way unless it's held.
                if (b.held) continue;
                const eta = b.speed > 0.5 ? b.dist / b.speed : Infinity;
                if (b.inBox || eta < 4 || (b.dist < 3 && b.speed > 0.1)) return 'give way (turning left)';
            }

        // Don't drive into a crossing car that is still in the junction.
        for (const b of others) if (b.inBox && !b.held && conflicts(a, b)) return 'junction busy';
        return null;
    }
}

// Direction a movement leaves the junction in.
const exitDir = (ag) => ag.move === 'S' ? ag.arm : ag.move === 'L' ? v2(-ag.arm.y, ag.arm.x) : v2(ag.arm.y, -ag.arm.x);

// Do two movements through the same junction cross paths?
export function conflicts(a, b) {
    const d = dot(a.arm, b.arm);
    if (d > 0.5) return false;                    // same approach: following
    // A right turn stays in its corner: it only meets traffic heading into
    // the same lane (straight on from its left, or an oncoming left turn).
    if (a.move === 'R' || b.move === 'R') return dot(exitDir(a), exitDir(b)) > 0.5;
    if (d < -0.5) return !(a.move === 'S' && b.move === 'S'); // opposite: a left turn crosses (or crowds) them
    return true;                                  // perpendicular straight / left turns cross
}

// Junction box test: which node's box (if any) is a point in?
export function boxAt(p) {
    const i = Math.round(p.x / PITCH), j = Math.round(p.y / PITCH);
    if (i < 0 || j < 0 || i > N || j > N) return null;
    const c = nodePos([i, j]);
    return Math.abs(p.x - c.x) < ROAD / 2 + 0.5 && Math.abs(p.y - c.y) < ROAD / 2 + 0.5 ? [i, j] : null;
}

// Would the rules hold this (rule-free) car at its line right now? Used so
// AI drivers queue patiently behind the player at a red light or give-way
// line instead of treating them as an obstacle to drive round.
export function heldByRules(junctions, a) {
    if (!a || a.dist < -1.5 || a.dist > 6 || a.speed > 0.5) return false;
    return junctions.decide({ ...a, committed: false, inBox: false }) !== null;
}

// Agent for a car with no planned route (the player): assume it goes
// straight on toward the next junction in the direction it is moving.
export function freeAgent(car) {
    const b = car.body;
    const speed = Math.hypot(b.vel.x, b.vel.y);
    const h = speed > 0.5 ? b.vel : v2(Math.cos(b.angle), Math.sin(b.angle));
    const arm = Math.abs(h.x) > Math.abs(h.y) ? v2(Math.sign(h.x), 0) : v2(0, Math.sign(h.y));
    const along = dot(b.pos, arm);
    const nodeAlong = Math.ceil((along - STOP_LINE + 1e-6) / PITCH) * PITCH; // next junction centre, in arm space
    const sign = arm.x || arm.y;
    const k = Math.round(nodeAlong / PITCH) * sign;
    const cross = arm.x ? Math.round(b.pos.y / PITCH) : Math.round(b.pos.x / PITCH);
    const node = arm.x ? [k, cross] : [cross, k];
    if (node[0] < 0 || node[1] < 0 || node[0] > N || node[1] > N) return null;
    const off = arm.x ? Math.abs(b.pos.y - cross * PITCH) : Math.abs(b.pos.x - cross * PITCH);
    if (off > ROAD / 2) return null; // not on that road
    const dist = nodeAlong - along - STOP_LINE - car.halfL;
    return { car, node, arm, move: 'S', dist, speed: Math.max(0, dot(b.vel, arm)), stopDist: 0, committed: true, inBox: dist < -car.halfL || (dist < -1.5 && Math.hypot(b.vel.x, b.vel.y) > 1), held: false, courtesy: false };
}
