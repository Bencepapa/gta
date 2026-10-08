// Vehicle Atlas Editor
//
// Mark up a sprite atlas of top-down vehicles: a box per sprite, its vehicle
// type, which way its front faces, where its lights are, and (for tractor
// units and semi-trailers) the coupling point. The wheel positions of the
// chosen type are drawn on top so you can see whether sprite and type fit.
//
// Data is saved as <atlas>.json next to the atlas image:
// {
//   version: 1, atlas: "vehicle-atlas-dr.webp", size: [w, h],
//   types: { id: { name, kind, length, width, wheelbase, track, axles?, coupling? } },
//   sprites: [{ id, x, y, w, h, front: 'up'|'down'|'left'|'right', type,
//               lights: [{ kind, side: 'L'|'R', u, v }], coupling? }]
// }
// Light / coupling positions are in the sprite's own frame, normalised:
// u along the vehicle (-0.5 rear .. +0.5 front), v across it (+0.5 left .. -0.5 right).
// Lengths in types are metres; axles / coupling are metres from the centre, + = forwards.

import { PRESETS } from '../src/vehicles.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view'), ctx = canvas.getContext('2d');

// ---------- default vehicle types (from the game's presets, plus articulated lorries) ----------
const KIND_OF_STYLE = { car: 'car', sport: 'car', wagon: 'car', van: 'van', bus: 'bus', lorry: 'lorry' };
// Plants: circles, no front, no lamps; size comes from the pixels in the game.
const FLORA_KINDS = new Set(['tree', 'bush', 'bare']);
const isFloraAtlas = () => /flora|plant|tree|noveny/i.test(atlasName);
const isFlora = (s) => s.shape === 'circle' || FLORA_KINDS.has(data.types[s.type]?.kind);
function floraTypes() {
    return {
        tree: { name: 'Nagy fa', kind: 'tree' }, smalltree: { name: 'Kis fa', kind: 'tree' },
        bush: { name: 'Bokor', kind: 'bush' }, bare: { name: 'Kopasz fa', kind: 'bare' },
    };
}
function defaultTypes() {
    if (isFloraAtlas()) return floraTypes();
    const t = {};
    for (const [id, p] of Object.entries(PRESETS)) {
        if (id === 'original') continue;
        t[id] = { name: p.name, kind: KIND_OF_STYLE[p.style] ?? 'car', length: p.length, width: p.width, wheelbase: p.wheelbase, track: p.track };
    }
    t.tractor = { name: 'Nyerges vontató', kind: 'tractor', length: 6.2, width: 2.5, wheelbase: 3.8, track: 2.05, axles: [1.9, -1.9], coupling: -1.4 };
    t.trailer = { name: 'Félpótkocsi', kind: 'trailer', length: 13.6, width: 2.55, track: 2.05, axles: [-3.9, -5.2, -6.5], coupling: 5.4 };
    return t;
}

const LIGHTS = {
    head: { label: 'Reflektor', color: '#fff6c2' },
    brake: { label: 'Féklámpa', color: '#ff3b30' },
    indicatorFront: { label: 'Index elöl', color: '#ffb400' },
    indicatorRear: { label: 'Index hátul', color: '#ffb400' },
    reverse: { label: 'Tolatólámpa', color: '#bfe3ff' },
};
const FRONT = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

// ---------- state ----------
let img = null, atlasName = '';
let data = null;            // the document being edited (see header)
let sel = null;             // selected sprite (the one whose details are shown)
const picked = new Set();   // all selected sprites (includes sel); edits apply to all of them
let mode = 'box';
const view = { scale: 1, ox: 0, oy: 0 };
let drag = null;            // current mouse interaction
let spaceDown = false;
let nextId = 1;
let lampKind = 'head';      // lamp placed by clicking in lamp mode

// ---------- sprite geometry ----------
const fw = (s) => FRONT[s.front];
const leftOf = (f) => ({ x: f.y, y: -f.x });                       // vehicle's left, in image coordinates
const lenPx = (s) => (s.front === 'up' || s.front === 'down' ? s.h : s.w);
const widPx = (s) => (s.front === 'up' || s.front === 'down' ? s.w : s.h);
const centre = (s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
function toImg(s, u, v) {                                          // sprite frame -> image px
    const c = centre(s), f = fw(s), l = leftOf(f);
    return { x: c.x + f.x * u * lenPx(s) + l.x * v * widPx(s), y: c.y + f.y * u * lenPx(s) + l.y * v * widPx(s) };
}
function toLocal(s, p) {                                           // image px -> sprite frame
    const c = centre(s), f = fw(s), l = leftOf(f), d = { x: p.x - c.x, y: p.y - c.y };
    return { u: (d.x * f.x + d.y * f.y) / lenPx(s), v: (d.x * l.x + d.y * l.y) / widPx(s) };
}
// Metres along / across the vehicle -> image px, scaled so the type's length fills the sprite.
function metresToImg(s, type, along, across) {
    const k = lenPx(s) / type.length, c = centre(s), f = fw(s), l = leftOf(f);
    return { x: c.x + (f.x * along + l.x * across) * k, y: c.y + (f.y * along + l.y * across) * k };
}
function axlesOf(type) {
    if (type.axles?.length) return type.axles;
    return [type.wheelbase / 2, -type.wheelbase / 2];
}

// Keep receiving a pointer's events while it's dragged outside the element.
function capture(el, id) {
    try { el.setPointerCapture(id); } catch { /* not a real pointer */ }
}

// ---------- view ----------
const toScreen = (p) => ({ x: p.x * view.scale + view.ox, y: p.y * view.scale + view.oy });
const toImage = (x, y) => ({ x: (x - view.ox) / view.scale, y: (y - view.oy) / view.scale });

function resize() {
    const dpr = devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    draw();
}
function fitView() {
    if (!img) return;
    const dpr = devicePixelRatio || 1;
    view.scale = Math.min(canvas.width / img.width, canvas.height / img.height) * 0.95;
    view.ox = (canvas.width - img.width * view.scale) / 2;
    view.oy = (canvas.height - img.height * view.scale) / 2;
    void dpr;
}

// ---------- drawing ----------
function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!img || !data) return;
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.drawImage(img, 0, 0);
    const px = 1 / view.scale; // one screen pixel in image units

    for (const s of data.sprites) {
        const isSel = s === sel, isPicked = picked.has(s);
        ctx.lineWidth = (isSel ? 2 : isPicked ? 2 : 1) * px * (devicePixelRatio || 1);
        ctx.strokeStyle = isSel ? '#8ce6c5' : isPicked ? '#4dd0ff' : s.type ? 'rgba(140,230,197,.55)' : 'rgba(255,176,32,.8)';
        if (s.shape === 'circle') {
            ctx.beginPath(); ctx.arc(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, 0, 7); ctx.stroke();
            if (isSel) { ctx.setLineDash([3 * px, 3 * px]); ctx.strokeRect(s.x, s.y, s.w, s.h); ctx.setLineDash([]); }
        } else ctx.strokeRect(s.x, s.y, s.w, s.h);
        if (!isFlora(s)) {
            // front marker: a small triangle on the front edge
            const tip = toImg(s, 0.5, 0), b1 = toImg(s, 0.42, 0.18), b2 = toImg(s, 0.42, -0.18);
            ctx.fillStyle = isSel ? '#8ce6c5' : 'rgba(140,230,197,.7)';
            ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y); ctx.closePath(); ctx.fill();
        }
        if (isSel) drawDetails(s, px);
        else for (const L of s.lights) drawLight(s, L, px * 3);
    }
    if (drag?.kind === 'new' || drag?.kind === 'marquee') {
        const r = rectOf(drag.a, drag.b);
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.strokeStyle = drag.kind === 'marquee' ? '#4dd0ff' : '#fff';
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
    }
}

function drawLight(s, L, r) {
    const p = toImg(s, L.u, L.v);
    ctx.fillStyle = LIGHTS[L.kind].color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = r * 0.35;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
}

function drawDetails(s, px) {
    const type = data.types[s.type];
    if (type && !isFlora(s)) {
        // wheels of the type, to scale
        const wl = 0.85, ww = 0.32;
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.strokeStyle = '#8ce6c5';
        ctx.lineWidth = 1.5 * px;
        for (const ax of axlesOf(type))
            for (const side of [1, -1]) {
                const corners = [[wl / 2, ww / 2], [wl / 2, -ww / 2], [-wl / 2, -ww / 2], [-wl / 2, ww / 2]]
                    .map(([a, c]) => metresToImg(s, type, ax + a, side * type.track / 2 + c));
                ctx.beginPath();
                corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                ctx.closePath(); ctx.fill(); ctx.stroke();
            }
        // the type's body outline at the same scale (shows a width mismatch)
        const o = [[0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [-0.5, 0.5]].map(([a, c]) => metresToImg(s, type, a * type.length, c * type.width));
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.strokeStyle = 'rgba(255,255,255,.6)';
        ctx.beginPath(); o.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
        ctx.setLineDash([]);
    }
    // coupling point (fifth wheel on a tractor, kingpin on a trailer)
    const cu = couplingU(s);
    if (cu !== null) {
        const p = toImg(s, cu, 0);
        ctx.strokeStyle = '#4dd0ff';
        ctx.lineWidth = 2 * px;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7 * px, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p.x - 10 * px, p.y); ctx.lineTo(p.x + 10 * px, p.y); ctx.moveTo(p.x, p.y - 10 * px); ctx.lineTo(p.x, p.y + 10 * px); ctx.stroke();
    }
    for (const L of s.lights) drawLight(s, L, 4 * px);
    // resize handles
    ctx.fillStyle = '#8ce6c5';
    for (const h of handles(s)) ctx.fillRect(h.x - 4 * px, h.y - 4 * px, 8 * px, 8 * px);
}

// Sprite's coupling position (u), from the sprite or else its type.
function couplingU(s) {
    if (s.coupling !== undefined) return s.coupling;
    const t = data.types[s.type];
    return t && (t.kind === 'tractor' || t.kind === 'trailer') && t.coupling !== undefined ? t.coupling / t.length : null;
}

// ---------- hit testing ----------
const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
const inside = (s, p) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
function handles(s) {
    return [
        { x: s.x, y: s.y, hx: -1, hy: -1 }, { x: s.x + s.w, y: s.y, hx: 1, hy: -1 },
        { x: s.x, y: s.y + s.h, hx: -1, hy: 1 }, { x: s.x + s.w, y: s.y + s.h, hx: 1, hy: 1 },
    ];
}
function hitHandle(s, p) {
    const r = 7 / view.scale;
    return handles(s).find((h) => Math.abs(h.x - p.x) < r && Math.abs(h.y - p.y) < r);
}
function insideShape(s, p) {
    if (s.shape !== 'circle') return inside(s, p);
    const r = s.w / 2;
    return Math.hypot(p.x - (s.x + r), p.y - (s.y + r)) <= r;
}
function hitSprite(p) {
    // smallest box under the cursor wins (boxes can overlap)
    let best = null;
    for (const s of data.sprites) if (insideShape(s, p) && (!best || s.w * s.h < best.w * best.h)) best = s;
    return best;
}
function hitLight(s, p) {
    const r = 7 / view.scale;
    return s.lights.findIndex((L) => { const q = toImg(s, L.u, L.v); return Math.hypot(q.x - p.x, q.y - p.y) < r; });
}

// ---------- mouse ----------
const evPos = (e) => {
    const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    return { sx: (e.clientX - r.left) * dpr, sy: (e.clientY - r.top) * dpr };
};
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { sx, sy } = evPos(e), before = toImage(sx, sy);
    view.scale = Math.min(40, Math.max(0.1, view.scale * Math.exp(-e.deltaY * 0.0015)));
    view.ox = sx - before.x * view.scale;
    view.oy = sy - before.y * view.scale;
    draw();
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
    if (!img || !data) return; // still loading
    capture(canvas, e.pointerId);
    const { sx, sy } = evPos(e), p = toImage(sx, sy);
    if (e.button === 2 || e.button === 1 || spaceDown) { drag = { kind: 'pan', sx, sy, ox: view.ox, oy: view.oy }; return; }

    // An existing lamp on the selected sprite: Alt+click deletes, otherwise drag it.
    if (sel) {
        const hit = hitLight(sel, p);
        if (hit >= 0) {
            if (e.altKey) { removeLight(hit); return; }
            const L = sel.lights[hit];
            const pair = $('mirror').checked ? sel.lights.find((M) => M !== L && M.kind === L.kind && M.side !== L.side) : null;
            drag = { kind: 'lamp', s: sel, L, pair };
            return;
        }
    }
    if (mode === 'light' && sel && inside(sel, p)) {
        placeLight(sel, toLocal(sel, p), lampKind);
        return;
    }
    if (mode === 'coupling' && sel && inside(sel, p)) {
        sel.coupling = round(toLocal(sel, p).u);
        changed();
        return;
    }
    if (sel) {
        const h = hitHandle(sel, p);
        if (h) { drag = { kind: 'resize', s: sel, h, start: { ...sel } }; return; }
    }
    const s = hitSprite(p);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (s && additive) {
        select(s, { toggle: true });
    } else if (s) {
        select(s);
        drag = { kind: 'move', s, from: p, start: { x: s.x, y: s.y } };
    } else if (e.shiftKey) {
        drag = { kind: 'marquee', a: p, b: p };
    } else if (mode === 'box') {
        drag = { kind: 'new', a: p, b: p };
    } else select(null);
});

canvas.addEventListener('pointermove', (e) => {
    const { sx, sy } = evPos(e), p = toImage(sx, sy);
    status(p);
    if (!drag) return;
    if (drag.kind === 'pan') { view.ox = drag.ox + sx - drag.sx; view.oy = drag.oy + sy - drag.sy; }
    else if (drag.kind === 'new' || drag.kind === 'marquee') drag.b = p;
    else if (drag.kind === 'move') {
        drag.s.x = Math.round(drag.start.x + p.x - drag.from.x);
        drag.s.y = Math.round(drag.start.y + p.y - drag.from.y);
        drag.moved = true;
    } else if (drag.kind === 'lamp') {
        const { s, L, pair } = drag, l = toLocal(s, p);
        L.u = round(l.u); L.v = round(l.v); L.side = L.v >= 0 ? 'L' : 'R';
        if (pair) { pair.u = L.u; pair.v = -L.v; pair.side = L.side === 'L' ? 'R' : 'L'; }
        drag.moved = true;
    } else if (drag.kind === 'resize') {
        const { s, h, start } = drag;
        let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
        if (h.hx < 0) x0 = p.x; else x1 = p.x;
        if (h.hy < 0) y0 = p.y; else y1 = p.y;
        if (s.shape === 'circle') {
            const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
            const ax = h.hx < 0 ? start.x + start.w : start.x, ay = h.hy < 0 ? start.y + start.h : start.y;
            Object.assign(s, rectInt({ x: h.hx < 0 ? ax - size : ax, y: h.hy < 0 ? ay - size : ay, w: size, h: size }));
        } else Object.assign(s, rectInt(rectOf({ x: x0, y: y0 }, { x: x1, y: y1 })));
        drag.moved = true;
    }
    draw();
});

canvas.addEventListener('pointerup', () => {
    if (drag?.kind === 'marquee') {
        // everything whose centre is inside the box joins the selection
        const r = rectOf(drag.a, drag.b);
        const hits = data.sprites.filter((s) => { const c = centre(s); return c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h; });
        selectMany(hits, true);
    } else if (drag?.kind === 'new') {
        const r = rectInt(rectOf(drag.a, drag.b));
        if (r.w > 4 && r.h > 4) {
            const s = newSprite(isFloraAtlas() ? circleAround({ ...r, w: r.w - 6, h: r.h - 6 }) : r);
            data.sprites.push(s);
            select(s);
            changed();
        }
    } else if (drag?.moved) changed();
    drag = null;
    draw();
});

const rectInt = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
const round = (x) => Math.round(x * 1000) / 1000;

function status(p) {
    const s = sel;
    let t = img ? `x ${Math.round(p.x)}  y ${Math.round(p.y)}  zoom ${(view.scale).toFixed(2)}×` : '';
    if (s && inside(s, p)) {
        const l = toLocal(s, p);
        t += `   ·  u ${l.u.toFixed(2)}  v ${l.v.toFixed(2)}`;
    }
    $('status').textContent = t;
}

// ---------- keyboard ----------
addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') { spaceDown = true; e.preventDefault(); }
    if (e.code === 'KeyB') setMode('box');
    if (e.code === 'KeyL') setMode('light');
    if (e.code === 'KeyC') setMode('coupling');
    if (e.code === 'Tab') { e.preventDefault(); cycle(e.shiftKey ? -1 : 1); }
    if (!sel) return;
    const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.code];
    if (arrow) { e.preventDefault(); setFront(arrow); }
    if (e.code === 'Delete' || e.code === 'Backspace') {
        const gone = picked.size ? picked : new Set([sel]);
        data.sprites = data.sprites.filter((s) => !gone.has(s));
        select(null);
        changed();
    }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

function cycle(d) {
    if (!data.sprites.length) return;
    const i = sel ? data.sprites.indexOf(sel) : -1;
    select(data.sprites[(i + d + data.sprites.length) % data.sprites.length]);
    centreOn(sel);
}
function centreOn(s) {
    const c = centre(s);
    view.ox = canvas.width / 2 - c.x * view.scale;
    view.oy = canvas.height / 2 - c.y * view.scale;
    draw();
}

// ---------- editing ----------
// Square box of the circle around a detected blob (plants).
function circleAround(r) {
    const size = Math.max(r.w, r.h) + 6;
    return { x: Math.round(r.x + r.w / 2 - size / 2), y: Math.round(r.y + r.h / 2 - size / 2), w: size, h: size, shape: 'circle' };
}
function newSprite(r) {
    if (r.shape === 'circle') return { id: `s${nextId++}`, ...r, front: 'up', type: r.w >= 116 ? 'tree' : r.w >= 72 ? 'smalltree' : 'bush', lights: [] };
    return { id: `s${nextId++}`, ...r, front: 'up', type: guessType(r), lights: [] };
}
// A first guess from the proportions; you'll correct it anyway.
function guessType(r) {
    const ratio = Math.max(r.w, r.h) / Math.min(r.w, r.h);
    return ratio > 4 ? 'bus' : ratio > 2.6 ? 'van' : 'sedan';
}

function placeLight(s, l, kind) {
    const side = l.v >= 0 ? 'L' : 'R';
    const add = (side, v) => {
        const i = s.lights.findIndex((L) => L.kind === kind && L.side === side);
        const L = { kind, side, u: round(l.u), v: round(v) };
        if (i >= 0) s.lights[i] = L; else s.lights.push(L);
    };
    add(side, l.v);
    if ($('mirror').checked) add(side === 'L' ? 'R' : 'L', -l.v);
    changed();
}
function removeLight(i) {
    sel.lights.splice(i, 1);
    changed();
}

function setFront(f) {
    for (const s of targets()) setFrontOf(s, f);
    changed();
}
function setFrontOf(s, f) {
    if (s.front === f) return;
    // lights stay put on the image: convert them through image space
    const pts = s.lights.map((L) => toImg(s, L.u, L.v));
    const cp = s.coupling !== undefined ? toImg(s, s.coupling, 0) : null;
    s.front = f;
    s.lights.forEach((L, i) => { const l = toLocal(s, pts[i]); L.u = round(l.u); L.v = round(l.v); L.side = L.v >= 0 ? 'L' : 'R'; });
    if (cp) s.coupling = round(toLocal(s, cp).u);
}
// The sprites an edit applies to: the whole selection.
const targets = () => (picked.size ? [...picked] : sel ? [sel] : []);

function setMode(m) {
    mode = m;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    canvas.style.cursor = m === 'box' ? 'crosshair' : 'cell';
}
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- lamp palette ----------
// Drag a lamp onto any sprite to place it there (selects the sprite), or
// click it to make it the lamp that clicks place in lamp mode.
function buildPalette() {
    const pal = $('lampPalette');
    pal.replaceChildren(...Object.entries(LIGHTS).map(([kind, info]) => {
        const chip = document.createElement('div');
        chip.className = 'chip' + (kind === lampKind ? ' on' : '');
        chip.innerHTML = `<span class="dot" style="background:${info.color}"></span>${info.label}`;
        chip.addEventListener('pointerdown', (e) => startPaletteDrag(e, kind, chip));
        return chip;
    }));
}
function pickLamp(kind) {
    lampKind = kind;
    buildPalette();
}
function startPaletteDrag(e, kind, chip) {
    e.preventDefault();
    capture(chip, e.pointerId);
    const ghost = chip.cloneNode(true);
    ghost.classList.add('ghost');
    let moved = false;
    const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 4) { moved = true; document.body.append(ghost); }
        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
    };
    const up = (ev) => {
        chip.removeEventListener('pointermove', move);
        chip.removeEventListener('pointerup', up);
        ghost.remove();
        if (!moved) { pickLamp(kind); setMode('light'); return; } // a click
        if (!data) return;
        const r = canvas.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
        const { sx, sy } = evPos(ev), p = toImage(sx, sy);
        const s = (sel && inside(sel, p)) ? sel : hitSprite(p);
        if (!s) { flash('Egy sprite-ra húzd a lámpát.'); return; }
        select(s);
        pickLamp(kind);
        placeLight(s, toLocal(s, p), kind);
    };
    chip.addEventListener('pointermove', move);
    chip.addEventListener('pointerup', up);
}
buildPalette();
document.querySelectorAll('[data-front]').forEach((b) => b.addEventListener('click', () => setFront(b.dataset.front)));

// ---------- automatic sprite detection ----------
// Opaque pixels (alpha >= threshold) are grouped into connected blobs on a
// coarse grid; each blob big enough becomes a box. Existing boxes are kept.
$('detectBtn').addEventListener('click', () => {
    if (!img) return;
    const thr = +$('alphaThr').value || 200, step = 2;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const a = g.getImageData(0, 0, img.width, img.height).data;
    const W = Math.ceil(img.width / step), H = Math.ceil(img.height / step);
    const solid = new Uint8Array(W * H), seen = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) solid[y * W + x] = a[((y * step) * img.width + x * step) * 4 + 3] >= thr ? 1 : 0;
    const found = [];
    for (let i = 0; i < W * H; i++) {
        if (!solid[i] || seen[i]) continue;
        let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
        const stack = [i]; seen[i] = 1;
        while (stack.length) {
            const k = stack.pop(), x = k % W, y = (k / W) | 0;
            n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, ny = y + dy, nk = ny * W + nx;
                if (nx >= 0 && ny >= 0 && nx < W && ny < H && solid[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
            }
        }
        const r = { x: x0 * step, y: y0 * step, w: (x1 - x0 + 1) * step, h: (y1 - y0 + 1) * step };
        if (r.w >= 16 && r.h >= 16 && n > 60) found.push(isFloraAtlas() ? circleAround(r) : r);
    }
    let added = 0;
    for (const r of found) {
        const overlaps = data.sprites.some((s) => r.x < s.x + s.w && r.x + r.w > s.x && r.y < s.y + s.h && r.y + r.h > s.y);
        if (!overlaps) { data.sprites.push(newSprite(r)); added++; }
    }
    // reading order: rows, then left to right; number fresh boxes in that order
    data.sprites.sort((p, q) => (Math.abs(p.y - q.y) > Math.min(p.h, q.h) / 2 ? p.y - q.y : p.x - q.x));
    if (added === data.sprites.length) data.sprites.forEach((s, i) => (s.id = `s${i + 1}`));
    nextId = data.sprites.length + 1;
    changed();
    flash(`${found.length} foltot találtam, ${added} új sprite.`);
});

// ---------- panels ----------
// select(s): just s. select(s, { toggle: true }): add s, or remove it if it was selected.
function select(s, { toggle = false } = {}) {
    if (!toggle) {
        picked.clear();
        if (s) picked.add(s);
        sel = s;
    } else if (s && picked.has(s)) {
        picked.delete(s);
        if (sel === s) sel = [...picked].pop() ?? null;
    } else if (s) {
        picked.add(s);
        sel = s;
    }
    refreshPanels();
    draw();
}
function selectMany(list, add = false) {
    if (!add) picked.clear();
    for (const s of list) picked.add(s);
    if (list.length) sel = list[0];
    else if (!picked.size) sel = null;
    refreshPanels();
    draw();
}
// Sprites in the same row as s (centres within half a sprite height).
const sameRow = (s) => data.sprites.filter((o) => Math.abs(centre(o).y - centre(s).y) < Math.min(o.h, s.h) / 2);
$('selRowBtn').addEventListener('click', () => sel && selectMany([sel, ...sameRow(sel).filter((o) => o !== sel)]));
$('selTypeBtn').addEventListener('click', () => sel && selectMany([sel, ...data.sprites.filter((o) => o !== sel && o.type === sel.type)]));

function refreshPanels() {
    // sprite list
    const list = $('spriteList');
    list.replaceChildren(...data.sprites.map((s) => {
        const d = document.createElement('div');
        d.className = picked.has(s) ? 'sel' : '';
        const t = data.types[s.type];
        d.innerHTML = `<span>${s.id}</span><span class="dim">${t ? t.name : '<span class=warn>?</span>'} · ${s.lights.length} lámpa</span>`;
        d.onclick = (e) => {
            if (e.shiftKey || e.ctrlKey || e.metaKey) select(s, { toggle: true });
            else { select(s); centreOn(s); }
        };
        return d;
    }));
    $('spriteCount').textContent = `(${data.sprites.length})`;
    $('spritePanel').hidden = !sel;
    const many = picked.size > 1;
    $('selTitle').textContent = many ? `${picked.size} sprite kijelölve – típus, eleje és törlés mindegyikre vonatkozik` : 'Kijelölt sprite';
    $('copyLightsBtn').textContent = many ? `Lámpák másolása (${sel?.id} → a többi ${picked.size - 1} kijelöltre)` : 'Lámpák másolása a típus többi sprite-jára';
    $('typePanel').hidden = !sel || !data.types[sel?.type];
    if (!sel) return;

    // sprite properties
    const ts = $('spriteType');
    ts.replaceChildren(new Option('— nincs —', ''), ...Object.entries(data.types).map(([id, t]) => new Option(`${t.name} (${id})`, id)));
    ts.value = sel.type ?? '';
    document.querySelectorAll('[data-front]').forEach((b) => b.classList.toggle('on', b.dataset.front === sel.front));
    $('frontRow').hidden = isFlora(sel);
    for (const k of ['x', 'y', 'w', 'h']) $('s' + k).value = sel[k];
    const type = data.types[sel.type];
    if (isFlora(sel)) {
        $('fitInfo').textContent = `Növény · átmérő ${sel.w} px`;
    } else if (type) {
        const spriteRatio = lenPx(sel) / widPx(sel), typeRatio = type.length / type.width;
        const off = (spriteRatio / typeRatio - 1) * 100;
        const mpp = type.length / lenPx(sel);
        $('fitInfo').innerHTML = `méretarány: sprite ${spriteRatio.toFixed(2)} · típus ${typeRatio.toFixed(2)} ` +
            (Math.abs(off) > 8 ? `<span class="warn">(${off > 0 ? '+' : ''}${off.toFixed(0)}% eltérés)</span>` : `<span>(${off.toFixed(0)}%)</span>`) +
            `<br>lépték: ${(1 / mpp).toFixed(1)} px/m`;
    } else $('fitInfo').textContent = 'Válassz típust a kerekek megjelenítéséhez.';

    $('lightList').replaceChildren(...sel.lights.map((L, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span><span class="dot" style="background:${LIGHTS[L.kind].color}"></span>${LIGHTS[L.kind].label} ${L.side === 'L' ? 'bal' : 'jobb'}</span>`;
        const b = document.createElement('button');
        b.textContent = '✕';
        b.onclick = () => removeLight(i);
        li.append(b);
        return li;
    }));

    // type editor
    if (type) {
        $('typeName').textContent = sel.type;
        $('tName').value = type.name;
        $('tKind').value = type.kind;
        $('tLength').value = type.length;
        $('tWidth').value = type.width;
        $('tWheelbase').value = type.wheelbase ?? '';
        $('tTrack').value = type.track;
        $('tAxles').value = (type.axles ?? []).join(', ');
        $('tCoupling').value = type.coupling ?? '';
        const plant = FLORA_KINDS.has(type.kind);
        for (const id of ['tLength', 'tWidth', 'tTrack']) $(id).closest('label').hidden = plant;
        const artic = type.kind === 'tractor' || type.kind === 'trailer';
        $('lblCoupling').hidden = !artic;
        $('couplingLabel').textContent = type.kind === 'trailer' ? 'királycsap' : 'nyeregszerkezet';
        $('lblAxles').hidden = type.kind === 'car' || plant;
        $('lblWheelbase').hidden = type.kind === 'trailer' || plant;
        $('typeHelp').textContent = plant
            ? 'Növény: a játékban a mérete a pixelekből jön (ugyanazzal a léptékkel, mint a járműveké).'
            : type.kind === 'trailer'
            ? 'Félpótkocsi: nincs saját kormányzott tengelye; a királycsapnál kapcsolódik a vontató nyeregszerkezetéhez. Tengelyek: méter a középponttól, negatív = hátra.'
            : type.kind === 'tractor'
                ? 'Nyerges vontató: a csatlakozó a nyeregszerkezet helye (méter a középponttól). A "Csatlakozó" eszközzel sprite-onként is megjelölhető.'
                : 'Tengelyek mező (opcionális) felülírja a tengelytávot, pl. háromtengelyes teherautónál.';
    }
}

$('spriteType').addEventListener('change', (e) => {
    for (const s of targets()) s.type = e.target.value || null;
    changed();
    if (picked.size > 1) flash(`${picked.size} sprite típusa: ${data.types[e.target.value]?.name ?? 'nincs'}`);
});
for (const k of ['x', 'y', 'w', 'h']) $('s' + k).addEventListener('change', (e) => { sel[k] = Math.round(+e.target.value); changed(); });

// type fields
const typeField = (id, key, parse) => $(id).addEventListener('change', (e) => {
    const t = data.types[sel.type];
    const v = parse(e.target.value);
    if (v === undefined) delete t[key]; else t[key] = v;
    changed();
});
const num = (x) => (x === '' ? undefined : +x);
typeField('tName', 'name', (x) => x);
typeField('tKind', 'kind', (x) => x);
typeField('tLength', 'length', num);
typeField('tWidth', 'width', num);
typeField('tWheelbase', 'wheelbase', num);
typeField('tTrack', 'track', num);
typeField('tCoupling', 'coupling', num);
typeField('tAxles', 'axles', (x) => { const a = x.split(',').map((s) => s.trim()).filter(Boolean).map(Number); return a.length && a.every(Number.isFinite) ? a : undefined; });

$('newTypeBtn').addEventListener('click', () => {
    const name = prompt('Új típus neve (pl. "Mikrobusz"):');
    if (!name) return;
    let id = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'type';
    while (data.types[id]) id += '-2';
    const base = data.types[sel.type] ?? { kind: 'car', length: 4.5, width: 1.9, wheelbase: 2.7, track: 1.55 };
    data.types[id] = { ...structuredClone(base), name };
    for (const s of targets()) s.type = id;
    changed();
});

$('copyLightsBtn').addEventListener('click', () => {
    if (!sel) return;
    let n = 0;
    const to = picked.size > 1 ? [...picked] : data.sprites.filter((s) => sel.type && s.type === sel.type);
    for (const s of to) if (s !== sel) { s.lights = structuredClone(sel.lights); n++; }
    flash(`Lámpák átmásolva ${n} sprite-ra.`);
    changed();
});

// ---------- load / save ----------
function emptyDoc(name) {
    return { version: 1, atlas: name, size: [img.width, img.height], types: defaultTypes(), sprites: [] };
}
const storeKey = () => `atlas-editor:${atlasName}`;
const jsonUrl = () => `../concept/${atlasName.replace(/\.[^.]+$/, '')}.json`;

let saveTimer = 0;
function changed() {
    data.modified = Date.now();
    refreshPanels();
    draw();
    try { localStorage.setItem(storeKey(), JSON.stringify(data)); } catch { /* storage full or blocked */ }
    clearTimeout(saveTimer);
    $('saveMsg').textContent = 'Módosítva (böngészőben mentve)';
}

async function save() {
    const body = JSON.stringify(data, null, 1);
    try {
        const r = await fetch(jsonUrl(), { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
        if (!r.ok) throw new Error(r.status);
        flash(`Mentve: concept/${jsonUrl().split('/').pop()}`);
    } catch {
        download(body);
        flash('A szerver nem fogadja a mentést (python serve.py kell) – letöltöttem a fájlt.');
    }
}
function download(body = JSON.stringify(data, null, 1)) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = jsonUrl().split('/').pop();
    a.click();
    URL.revokeObjectURL(a.href);
}
function flash(msg) { $('saveMsg').textContent = msg; }

$('saveBtn').addEventListener('click', save);
$('exportBtn').addEventListener('click', () => download());
$('importBtn').addEventListener('click', () => $('importIn').click());
$('importIn').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { useDoc(JSON.parse(await f.text())); flash('Importálva.'); } catch (err) { flash('Hibás JSON: ' + err.message); }
});
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); save(); } });

function useDoc(doc) {
    data = doc;
    data.types = { ...defaultTypes(), ...(data.types ?? {}) };
    data.sprites ??= [];
    nextId = 1 + Math.max(0, ...data.sprites.map((s) => +String(s.id).replace(/\D/g, '') || 0));
    select(null);
}

async function loadAtlas(name, src) {
    atlasName = name;
    img = new Image();
    img.src = src;
    await img.decode();
    // saved file on disk first, then this browser's autosave, else a fresh document
    let doc = null;
    try { const r = await fetch(jsonUrl(), { cache: 'no-store' }); if (r.ok) doc = await r.json(); } catch { /* none yet */ }
    // The browser's autosave wins only if it's newer than the saved file.
    try {
        const local = JSON.parse(localStorage.getItem(storeKey()));
        if (local && (!doc || (local.modified ?? 0) > (doc.modified ?? 0))) doc = local;
    } catch { /* ignore */ }
    useDoc(doc ?? emptyDoc(name));
    fitView();
    draw();
    $('saveMsg').textContent = doc ? `Betöltve: ${data.sprites.length} sprite` : 'Új dokumentum – próbáld az „Automatikus felismerés”-t.';
}

// Atlas images in /concept (read from the dev server's folder listing).
async function listAtlases() {
    let names = [];
    try {
        const html = await (await fetch('../concept/', { cache: 'no-store' })).text();
        names = [...html.matchAll(/href="([^"]+\.(?:webp|png|jpe?g))"/gi)].map((m) => decodeURIComponent(m[1]));
    } catch { /* no listing */ }
    if (!names.length) names = ['vehicle-atlas-dr.webp', 'vehicle-atlas-e2.webp'];
    names = names.filter((n) => !/asphalt/i.test(n));
    const sel = $('atlasSel');
    sel.replaceChildren(...names.map((n) => new Option(n, n)));
    sel.onchange = () => loadAtlas(sel.value, `../concept/${sel.value}`);
    if (names.length) await loadAtlas(names[0], `../concept/${names[0]}`);
}
$('openBtn').addEventListener('click', () => $('fileIn').click());
$('fileIn').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadAtlas(f.name, URL.createObjectURL(f));
});

addEventListener('resize', resize);
resize();
listAtlases();
