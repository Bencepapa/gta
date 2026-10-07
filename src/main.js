import { v2, add, sub, mul, dot, len, fromAngle } from './vec.js';
import { Car } from './car.js';
import { Driver } from './ai.js';
import { buildCity, nodePos, neighbours, randomVehicle, PITCH, ROAD, LANE, N } from './city.js';
import { collideAll } from './collide.js';
import { PRESETS, TRAFFIC_MIX } from './vehicles.js';
import { createDebugPanel, isTyping } from './debug.js';
import { SteerAssist, BrakeAssist } from './assist.js';
import { Horn } from './horn.js';
import { TouchControls } from './touch.js';
import { Junctions, freeAgent, boxAt, nodeKey, axisOf, STOP_LINE, heldByRules } from './junctions.js';
import { SpatialGrid } from './spatial.js';
import { Violations } from './violations.js';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');

const STEP = 1 / 120;
const TRAFFIC = 30;
const MAX_TRAFFIC = 200;
const NEAR = 40; // m: how far an AI driver looks for other traffic
// AI drivers re-think every AI_EVERY physics steps (30 times a second),
// staggered so only a share of them do it on any one step. Physics still
// runs every step with their latest controls.
const AI_EVERY = 4;
let stepNo = 0;
const CRATE_DRAG = 3; // 1/s, sliding friction for loose crates

// ---------- world ----------
const city = buildCity();
const { statics, crates } = city;
const cars = [...city.parked];
const drivers = new Map(); // car -> Driver

function placeOnRoad(car, from, to, t) {
    const a = nodePos(from), b = nodePos(to);
    const d = mul(sub(b, a), 1 / len(sub(b, a)));
    car.body.pos = add(add(a, mul(sub(b, a), t)), mul(v2(d.y, -d.x), LANE));
    car.body.angle = Math.atan2(d.y, d.x);
}

let player = new Car({ ...PRESETS.classic, color: '#ffd23f' });
placeOnRoad(player, [2, 2], [3, 2], 0.3);
cars.push(player);

let dynamics = [];
const junctions = new Junctions();
const violations = new Violations(junctions);
const grid = new SpatialGrid();
let trafficWanted = 0;
const rebuildDynamics = () => { dynamics = [...cars, ...crates]; };

// Grow or shrink AI traffic. New cars appear away from the player; removed
// cars are the ones furthest away, so changes happen mostly off-screen.
function setTraffic(n) {
    const r = city.rand;
    n = Math.max(0, Math.min(MAX_TRAFFIC, n));
    trafficWanted = n;
    while (drivers.size > n) {
        let far = null, farD = -1;
        for (const c of drivers.keys()) {
            const d = len(sub(c.body.pos, player.body.pos));
            if (d > farD) { far = c; farD = d; }
        }
        drivers.delete(far);
        cars.splice(cars.indexOf(far), 1);
        for (const w of far.wheels) lastSkid.delete(w);
    }
    // Free spots are checked against a grid; give up when the roads are full.
    grid.rebuild(cars);
    const budget = Math.min(200000, 400 + (n - drivers.size) * 40);
    for (let tries = 0, misses = 0; drivers.size < n && tries < budget && misses < 3000; tries++) {
        const from = [Math.floor(r() * (N + 1)), Math.floor(r() * (N + 1))];
        const opts = neighbours(from);
        const to = opts[Math.floor(r() * opts.length)];
        const car = randomVehicle(TRAFFIC_MIX, r);
        placeOnRoad(car, from, to, 0.2 + r() * 0.6);
        if (len(sub(car.body.pos, player.body.pos)) < 25) continue;
        if (grid.near(car.body.pos, 16).some((c) => len(sub(c.body.pos, car.body.pos)) < c.radius + car.radius + 2)) { misses++; continue; }
        misses = 0;
        cars.push(car);
        grid.insert(car);
        drivers.set(car, new Driver(car, from, to, r));
    }
    rebuildDynamics();
}

// ---------- input ----------
const keys = new Set();
const options = {
    speedZoom: true, timeScale: 1, showAI: false,
    // steering assist (see assist.js)
    assist: true, assistAngle: 15, assistStrength: 1, tapTime: 0.2, tapScale: 0.5,
};
const assist = new SteerAssist(options);
const horn = new Horn();

// The player's lights: Q / E indicators (press again to cancel), Tab hazards.
function toggleSignal(which) {
    player.signal = player.signal === which ? null : which;
}

addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    if (!e.repeat) {
        if (e.code === 'KeyX') options.speedZoom = !options.speedZoom;
        if (e.code === 'KeyZ') { options.assist = !options.assist; debug?.refresh(); }
        if (e.code === 'KeyF') switchCar();
        if (e.code === 'KeyQ') toggleSignal('left');
        if (e.code === 'KeyE') toggleSignal('right');
        if (e.code === 'Tab') toggleSignal('hazard');
        if (e.code === 'KeyH') horn.start();
    }
    keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
});
addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.code === 'KeyH') horn.stop();
});
addEventListener('blur', () => { keys.clear(); horn.stop(); });

const held = (...codes) => codes.some((c) => keys.has(c));
const brakeAssist = new BrakeAssist();
const touch = new TouchControls({
    toggleSignal: (which) => toggleSignal(which),
    getSignal: () => player.signal,
    hornStart: () => horn.start(),
    hornStop: () => horn.stop(),
});
// Keyboard and touch together: keys win when pressed, otherwise the touch controls.
const playerControls = (dt) => {
    const t = touch.state;
    const keyThrottle = (held('ArrowUp', 'KeyW') ? 1 : 0) - (held('ArrowDown', 'KeyS') ? 1 : 0);
    const keySteer = (held('ArrowLeft', 'KeyA') ? 1 : 0) - (held('ArrowRight', 'KeyD') ? 1 : 0);
    return brakeAssist.apply(player, {
        throttle: keyThrottle || t.throttle - t.brake,
        steer: keySteer || t.steer,
        handbrake: held('Space') || t.handbrake,
    }, dt);
};
const PARKED = { throttle: 0, steer: 0, handbrake: true };

// Jump into the nearest other car (it stops being AI-driven).
function switchCar() {
    let best = null, bestD = 8;
    for (const c of cars) {
        const d = len(sub(c.body.pos, player.body.pos));
        if (c !== player && d < bestD) { best = c; bestD = d; }
    }
    if (!best) return;
    drivers.delete(best);
    player = best;
    debug?.refresh();
}

// ---------- skid marks ----------
const skids = [];
const MAX_SKIDS = 6000;
const lastSkid = new Map(); // wheel -> last mark point
setTraffic(TRAFFIC);
function recordSkids() {
    for (const car of cars)
        for (const w of car.wheels) {
            if (w.front) continue;
            const prev = lastSkid.get(w);
            if (!w.skidding) { lastSkid.delete(w); continue; }
            if (!prev) { lastSkid.set(w, w.world); continue; }
            if (len(sub(w.world, prev)) > 0.15) {
                skids.push(prev, w.world);
                if (skids.length > MAX_SKIDS * 2) skids.splice(0, 2);
                lastSkid.set(w, w.world);
            }
        }
}

// ---------- simulation ----------
// Tell the junction controller who is approaching / inside each junction.
function updateJunctions(dt) {
    junctions.step(dt);
    const agents = [];
    for (const car of cars) {
        const driver = drivers.get(car);
        const a = driver ? driver.junctionAgent() : car === player ? freeAgent(car) : null;
        // The player has no planned route; their indicator says where they're going.
        if (a && car === player && (player.signal === 'left' || player.signal === 'right'))
            a.move = player.signal === 'left' ? 'L' : 'R';
        if (a) agents.push(a);
        // Still inside the box of the junction we just drove through.
        const box = boxAt(car.body.pos);
        const prev = car.prevJunction;
        if (box && prev && (!a || nodeKey(a.node) !== nodeKey(box)) && nodeKey(prev.node) === nodeKey(box))
            agents.push({ ...prev, inBox: true, dist: -1, committed: true, held: false });
    }
    junctions.setAgents(agents);
    // The player waiting at a red light / give-way line counts as queuing.
    player.queued = heldByRules(junctions, agents.find((a) => a.car === player));
    return agents;
}

const isAI = (c) => drivers.has(c);

function tick(dt) {
    const agents = updateJunctions(dt);
    violations.update(dt, cars, agents, player, isAI);
    grid.rebuild(dynamics);
    stepNo++;
    player.flashHold = held('KeyR') || touch.state.flash;
    player.honking = held('KeyH') || touch.state.horn;
    for (const car of cars) {
        const driver = drivers.get(car);
        let controls;
        if (car === player) controls = assist.apply(player, playerControls(dt), dt);
        else if (!driver) controls = PARKED;
        else {
            if (!driver.last || (stepNo + car.id) % AI_EVERY === 0)
                driver.last = driver.controls(grid.near(car.body.pos, NEAR), dt * AI_EVERY, junctions);
            controls = driver.last;
        }
        car.update(controls, dt);
    }
    for (const c of crates) {
        const b = c.body;
        b.applyForce(mul(b.vel, -b.mass * CRATE_DRAG));
        b.torque -= b.inertia * CRATE_DRAG * b.angVel;
        b.step(dt);
    }
    collideAll(dynamics, statics);
    recordSkids();
}

// ---------- rendering ----------
function resize() {
    const dpr = devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
}
addEventListener('resize', resize);
resize();

let zoom = 16;
const cam = { ...player.body.pos };

function box(e, fill, stroke, lw = 0.08) {
    const { body: b, halfL: x, halfW: y } = e;
    ctx.save();
    ctx.translate(b.pos.x, b.pos.y);
    ctx.rotate(b.angle);
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(-x, -y, 2 * x, 2 * y); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.strokeRect(-x, -y, 2 * x, 2 * y); }
    ctx.restore();
}

function drawGround() {
    const lo = -ROAD / 2, hi = N * PITCH + ROAD / 2;
    ctx.fillStyle = '#3b4048'; // asphalt everywhere, blocks drawn on top
    ctx.fillRect(lo, lo, hi - lo, hi - lo);
    for (const b of city.blocks) {
        ctx.fillStyle = '#8a8d91'; // pavement
        ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        ctx.fillStyle = b.type === 'park' ? '#4f7a45' : b.type === 'lot' ? '#55595f' : '#6d7a5c';
        ctx.fillRect(b.x0 + 3, b.y0 + 3, b.x1 - b.x0 - 6, b.y1 - b.y0 - 6);
        if (b.type === 'lot') {
            ctx.strokeStyle = '#d9d9d9';
            ctx.lineWidth = 0.12;
            ctx.beginPath();
            for (let x = b.x0 + 3.4; x < b.x1 - 3; x += 3.2)
                for (const [y0, y1] of [[b.y0 + 3, b.y0 + 8], [b.y1 - 8, b.y1 - 3]]) {
                    ctx.moveTo(x, y0); ctx.lineTo(x, y1);
                }
            ctx.stroke();
        }
    }
    // Centre-line dashes between junctions.
    ctx.strokeStyle = '#e8c547';
    ctx.lineWidth = 0.25;
    ctx.setLineDash([2.5, 2.5]);
    ctx.beginPath();
    for (let i = 0; i <= N; i++)
        for (let j = 0; j < N; j++) {
            const a = j * PITCH + ROAD / 2, b = (j + 1) * PITCH - ROAD / 2;
            ctx.moveTo(i * PITCH, a); ctx.lineTo(i * PITCH, b);
            ctx.moveTo(a, i * PITCH); ctx.lineTo(b, i * PITCH);
        }
    ctx.stroke();
    ctx.setLineDash([]);
}

// Stop / give-way lines on the road, and signs + traffic lights on the
// pavement at the right-hand side of each approach.
const LIGHT_COLORS = { green: '#3ddc6a', amber: '#ffb020', red: '#ff3b30' };
function drawJunctions(layer) {
    for (const J of junctions.nodes.values()) {
        if (J.type === 'corner' || J.type === 'equal') continue; // unsigned: right-hand rule
        if (Math.abs(J.pos.x - cam.x) > 80 || Math.abs(J.pos.y - cam.y) > 60) continue;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            // Approach arm: traffic coming from the neighbour at (i - di, j - dj), travelling (di, dj).
            const fi = J.i - di, fj = J.j - dj;
            if (fi < 0 || fj < 0 || fi > N || fj > N) continue;
            const arm = { x: di, y: dj }, right = { x: dj, y: -di };
            const at = (along, side) => ({ x: J.pos.x - arm.x * along + right.x * side, y: J.pos.y - arm.y * along + right.y * side });
            const priority = J.type === 'priority' && axisOf(arm) === J.mainAxis;
            if (layer === 'markings') {
                if (priority) continue;
                const a = at(STOP_LINE, 0.25), b = at(STOP_LINE, ROAD / 2 - 0.25);
                ctx.strokeStyle = '#f2f2f2';
                ctx.lineWidth = J.type === 'lights' ? 0.4 : 0.3;
                ctx.setLineDash(J.type === 'lights' ? [] : [0.6, 0.5]);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                ctx.setLineDash([]);
                continue;
            }
            if (J.type === 'lights') {
                const p = at(STOP_LINE - 0.2, ROAD / 2 + 1.1);
                const state = junctions.light(J, axisOf(arm));
                ctx.fillStyle = '#15171a';
                ctx.fillRect(p.x - 0.55, p.y - 1.5, 1.1, 3);
                ['red', 'amber', 'green'].forEach((c, k) => {
                    ctx.fillStyle = state === c ? LIGHT_COLORS[c] : '#34383e';
                    ctx.beginPath(); ctx.arc(p.x, p.y + 0.95 - k * 0.95, 0.38, 0, 7); ctx.fill();
                });
            } else {
                const p = at(STOP_LINE + 1.5, ROAD / 2 + 1.3);
                ctx.lineWidth = 0.15;
                if (priority) { // yellow diamond: priority road
                    ctx.beginPath();
                    ctx.moveTo(p.x, p.y + 0.9); ctx.lineTo(p.x + 0.9, p.y); ctx.lineTo(p.x, p.y - 0.9); ctx.lineTo(p.x - 0.9, p.y);
                    ctx.closePath();
                    ctx.fillStyle = '#ffd23f'; ctx.fill();
                    ctx.strokeStyle = '#fff'; ctx.stroke();
                } else { // inverted triangle: give way
                    ctx.beginPath();
                    ctx.moveTo(p.x - 0.95, p.y + 0.75); ctx.lineTo(p.x + 0.95, p.y + 0.75); ctx.lineTo(p.x, p.y - 0.95);
                    ctx.closePath();
                    ctx.fillStyle = '#fff'; ctx.fill();
                    ctx.strokeStyle = '#d62b2b'; ctx.lineWidth = 0.28; ctx.stroke();
                }
            }
        }
    }
}

// Indicators / hazard lights (blinking amber at all four corners on the
// signalled side) and the double headlight flash used to give way.
function drawCarLights(car, x, y) {
    if (car.honking) { // sound rings spreading from the bonnet
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 0.12;
        for (let k = 0; k < 3; k++) {
            const r = 1 + ((junctions.t * 6 + k * 1.3) % 4);
            ctx.globalAlpha = 1 - (r - 1) / 4;
            ctx.beginPath(); ctx.arc(x * 0.6, 0, r, -0.9, 0.9); ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
    car.blinkPhase ??= Math.random();
    const sig = car.signal;
    if (sig && ((junctions.t * 1.5 + car.blinkPhase) % 1) < 0.5) {
        const sides = sig === 'hazard' ? [1, -1] : [sig === 'left' ? 1 : -1];
        for (const side of sides)
            for (const ex of [x - 0.2, -x + 0.2]) {
                const ey = side * (y - 0.05);
                ctx.fillStyle = 'rgba(255,174,0,0.35)';
                ctx.beginPath(); ctx.arc(ex, ey, 0.65, 0, 7); ctx.fill();
                ctx.fillStyle = '#ffb400';
                ctx.beginPath(); ctx.arc(ex, ey, 0.26, 0, 7); ctx.fill();
            }
    }
    // Two short flashes = "go ahead"; one long flash = "hey, you!"
    const short = car.flash > 0 && ((0.9 - car.flash) < 0.18 || ((0.9 - car.flash) > 0.36 && (0.9 - car.flash) < 0.54));
    if (short || car.flashLong > 0 || car.flashHold) {
        ctx.fillStyle = 'rgba(255,250,215,0.28)';
        ctx.beginPath(); // beams
        ctx.moveTo(x, y - 0.3); ctx.lineTo(x + 7, y + 1.6); ctx.lineTo(x + 7, -y - 1.6); ctx.lineTo(x, -y + 0.3);
        ctx.closePath(); ctx.fill();
        for (const side of [1, -1]) {
            ctx.fillStyle = 'rgba(255,255,230,0.6)';
            ctx.beginPath(); ctx.arc(x, side * (y - 0.35), 0.6, 0, 7); ctx.fill();
            ctx.fillStyle = '#fffbe8';
            ctx.beginPath(); ctx.arc(x, side * (y - 0.35), 0.28, 0, 7); ctx.fill();
        }
    }
}

function drawCar(car) {
    const b = car.body;
    ctx.save();
    ctx.translate(b.pos.x, b.pos.y);
    ctx.rotate(b.angle);
    const big = car.cfg.mass > 4000;
    const tl = big ? 0.55 : 0.4, tw = big ? 0.2 : 0.15;
    for (const w of car.wheels) {
        ctx.save();
        ctx.translate(w.local.x, w.local.y);
        ctx.rotate(w.steer);
        ctx.fillStyle = '#0b0d10';
        ctx.fillRect(-tl, -tw, 2 * tl, 2 * tw);
        ctx.restore();
    }
    const x = car.halfL, y = car.halfW - 0.1;
    const glass = 'rgba(20,30,45,0.75)';
    ctx.fillStyle = car.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 0.08;
    ctx.fillRect(-x, -y, 2 * x, 2 * y);
    ctx.strokeRect(-x, -y, 2 * x, 2 * y);
    ctx.fillStyle = glass;
    switch (car.cfg.style) {
        case 'bus': // windscreen plus a row of side windows
            ctx.fillRect(x - 0.5, -y + 0.15, 0.35, 2 * y - 0.3);
            for (let wx = -x + 0.8; wx < x - 1.4; wx += 1.3) {
                ctx.fillRect(wx, y - 0.35, 1, 0.2);
                ctx.fillRect(wx, -y + 0.15, 1, 0.2);
            }
            break;
        case 'lorry': { // cab up front, separate cargo box behind
            const cab = 2.2;
            ctx.fillRect(x - 0.7, -y + 0.2, 0.4, 2 * y - 0.4);
            ctx.fillStyle = '#c9ccd1';
            ctx.fillRect(-x, -y - 0.05, 2 * x - cab - 0.15, 2 * y + 0.1);
            ctx.strokeRect(-x, -y - 0.05, 2 * x - cab - 0.15, 2 * y + 0.1);
            break;
        }
        case 'van':
            ctx.fillRect(x - 1.1, -y + 0.15, 0.5, 2 * y - 0.3);
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.strokeRect(-x + 0.3, -y + 0.3, 2 * x - 1.7, 2 * y - 0.6);
            break;
        case 'wagon': // long roof, windows all the way back
            ctx.fillRect(x - 1.6, -y + 0.2, 0.5, 2 * y - 0.4);
            ctx.fillRect(-x + 0.25, -y + 0.25, 0.3, 2 * y - 0.5);
            ctx.fillRect(-x + 0.8, y - 0.3, 2 * x - 2.6, 0.15);
            ctx.fillRect(-x + 0.8, -y + 0.15, 2 * x - 2.6, 0.15);
            break;
        case 'sport': // low, long bonnet, racing stripe
            ctx.fillRect(-0.2, -y + 0.25, 0.6, 2 * y - 0.5);
            ctx.fillRect(-x + 0.5, -y + 0.35, 0.35, 2 * y - 0.7);
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillRect(0.4, -0.18, x - 0.4, 0.12);
            ctx.fillRect(0.4, 0.06, x - 0.4, 0.12);
            break;
        default:
            ctx.fillRect(x - 1.5, -y + 0.2, 0.55, 2 * y - 0.4);
            ctx.fillRect(-x + 0.4, -y + 0.25, 0.4, 2 * y - 0.5);
    }
    drawCarLights(car, x, y);
    ctx.restore();
}

// Text label next to each AI car saying what its driver is doing.
const AI_LABEL_COLORS = { junction: '#e86bff', driving: '#46d27a', waiting: '#ffb020', stuck: '#ff8a3d', reversing: '#ff4d4d', detour: '#4da3ff' };
function aiLabel(d) {
    if (d.holdReason) return ['junction', d.holdReason];
    if (d.state === 'reverse') return ['reversing', d.turningRound ? 'reversing · turning round' : `reversing · try ${d.attempts}`];
    if (d.state === 'detour') return ['detour', d.waiting ? 'detour · waiting' : 'detour'];
    if (d.stuck > 0.3) return ['stuck', `stuck ${d.stuck.toFixed(1)}s`];
    if (d.waiting) return ['waiting', d.waited > 0.05 ? `waiting ${d.waited.toFixed(1)}s` : 'waiting · traffic'];
    return ['driving', 'driving'];
}
function drawAILabels(W, H, s, visible) {
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = 'middle';
    for (const [c, d] of drivers) {
        if (!visible(c)) continue;
        const [kind, text] = aiLabel(d);
        const x = W / 2 + (c.body.pos.x - cam.x) * s + (c.radius * s) * 0.6;
        const y = H / 2 - (c.body.pos.y - cam.y) * s - (c.radius * s) * 0.6;
        const w = ctx.measureText(text).width, pad = 4 * dpr, h = 16 * dpr;
        ctx.fillStyle = 'rgba(10,12,16,0.8)';
        ctx.fillRect(x, y - h / 2, w + pad * 3 + 6 * dpr, h);
        ctx.fillStyle = AI_LABEL_COLORS[kind];
        ctx.fillRect(x + pad, y - 3 * dpr, 6 * dpr, 6 * dpr);
        ctx.fillText(text, x + pad * 2 + 6 * dpr, y);
    }
}

function draw(frameDt) {
    const b = player.body;
    const speed = len(b.vel);
    const targetZoom = options.speedZoom ? 20 / (1 + speed * 0.03) : 16;
    zoom += (targetZoom - zoom) * Math.min(1, frameDt * 3);
    const target = add(b.pos, mul(b.vel, 0.3));
    cam.x += (target.x - cam.x) * Math.min(1, frameDt * 6);
    cam.y += (target.y - cam.y) * Math.min(1, frameDt * 6);

    const dpr = devicePixelRatio || 1;
    const W = canvas.width, H = canvas.height, s = zoom * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2d3a28';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, -s, W / 2 - cam.x * s, H / 2 + cam.y * s);

    const vx = W / s / 2 + 10, vy = H / s / 2 + 10;
    const visible = (e) => Math.abs(e.body.pos.x - cam.x) < vx + e.radius && Math.abs(e.body.pos.y - cam.y) < vy + e.radius;

    drawGround();
    drawJunctions('markings');

    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 0.28;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < skids.length; i += 2) { ctx.moveTo(skids[i].x, skids[i].y); ctx.lineTo(skids[i + 1].x, skids[i + 1].y); }
    for (const [w, p] of lastSkid) { ctx.moveTo(p.x, p.y); ctx.lineTo(w.world.x, w.world.y); }
    ctx.stroke();

    for (const c of crates) if (visible(c)) {
        box(c, '#a87b4a', '#5e4126', 0.1);
        ctx.save();
        ctx.translate(c.body.pos.x, c.body.pos.y);
        ctx.rotate(c.body.angle);
        ctx.strokeStyle = '#5e4126';
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.moveTo(-c.halfL, -c.halfW); ctx.lineTo(c.halfL, c.halfW);
        ctx.moveTo(-c.halfL, c.halfW); ctx.lineTo(c.halfL, -c.halfW);
        ctx.stroke();
        ctx.restore();
    }

    for (const c of cars) if (visible(c)) drawCar(c);

    // Buildings and trees sit "above" the street, like the GTA camera.
    for (const e of statics) if (visible(e)) {
        const p = e.body.pos;
        if (e.kind === 'house') {
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(p.x - e.halfL + 1.2, p.y - e.halfW - 1.2, 2 * e.halfL, 2 * e.halfW);
            box(e, e.color, 'rgba(0,0,0,0.5)', 0.15);
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.15;
            ctx.beginPath(); // roof ridge along the long side
            if (e.halfL >= e.halfW) { ctx.moveTo(p.x - e.halfL + e.halfW, p.y); ctx.lineTo(p.x + e.halfL - e.halfW, p.y); }
            else { ctx.moveTo(p.x, p.y - e.halfW + e.halfL); ctx.lineTo(p.x, p.y + e.halfW - e.halfL); }
            ctx.stroke();
        } else if (e.kind === 'tree') {
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.beginPath(); ctx.arc(p.x + 0.8, p.y - 0.8, e.canopy, 0, 7); ctx.fill();
            ctx.fillStyle = '#2f6b34';
            ctx.beginPath(); ctx.arc(p.x, p.y, e.canopy, 0, 7); ctx.fill();
        } else box(e, '#1d2024');
    }

    drawJunctions('signs');
    if (options.showAI) drawAILabels(W, H, s, visible);

    const fwd = dot(b.vel, fromAngle(b.angle));
    const msg = violations.lastForPlayer && junctions.t - violations.lastForPlayer.t < 4 ? `\n⚠ ${violations.lastForPlayer.text}` : '';
    const lights = (player.signal ? `   ● ${player.signal === 'hazard' ? 'HAZARDS' : player.signal.toUpperCase() + ' indicator'}` : '') +
        (player.honking ? '   📯 HONK' : '');
    // On touch screens the keyboard help just gets in the way.
    if (touch.active) { hud.textContent = `${(speed * 3.6).toFixed(0)} km/h` + lights + msg; return; }
    hud.textContent =
        `speed ${(speed * 3.6).toFixed(0)} km/h  (fwd ${fwd.toFixed(1)} m/s)   cars ${cars.length}  crates ${crates.length}\n` +
        `[W/S ↑/↓] throttle/brake  [A/D ←/→] steer  [Space] handbrake  [F] take nearest car  ` +
        `[X] speed zoom ${options.speedZoom ? 'on' : 'off'}  [Z] steer assist ${options.assist ? (assist.active ? 'ON ●' : 'on') : 'off'}  [\`] debug\n` +
        `[Q/E] indicators  [Tab] hazards  [H] horn  [R] flash headlights` + lights + msg;
}

// ---------- fixed-step loop ----------
let last = null, acc = 0;
function frame(t) {
    const dt = last === null ? 0 : Math.min((t - last) / 1000, 0.1);
    last = t;
    acc += dt * options.timeScale;
    while (acc >= STEP) { tick(STEP); acc -= STEP; }
    draw(dt);
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const debug = createDebugPanel({
    getCar: () => player,
    applyCar: (cfg) => player.configure(cfg),
    getTraffic: () => drivers.size,
    getTrafficWanted: () => trafficWanted,
    setTraffic,
    maxTraffic: MAX_TRAFFIC,
    getOption: (k) => options[k],
    setOption: (k, v) => { options[k] = v; },
});
canvas.addEventListener('pointerdown', () => document.activeElement?.blur());
