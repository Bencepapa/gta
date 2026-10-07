import { v2 } from './vec.js';
import { Body } from './body.js';
import { Car } from './car.js';
import { PRESETS, PARKING_MIX, pickWeighted } from './vehicles.js';

// A grid city: roads run along x = i*PITCH and y = j*PITCH for i, j in 0..N.
export const PITCH = 56;
export const ROAD = 14;
export const LANE = 3.5; // lane centre offset from road centre
export const N = 5;
export const SIDEWALK = 3;

export const nodePos = ([i, j]) => v2(i * PITCH, j * PITCH);
export const neighbours = ([i, j]) =>
    [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]].filter(
        ([a, b]) => a >= 0 && b >= 0 && a <= N && b <= N,
    );

export function rng(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function solid(kind, x, y, halfL, halfW, extra = {}) {
    const body = new Body({ mass: Infinity, inertia: Infinity });
    body.pos = v2(x, y);
    return { kind, body, halfL, halfW, radius: Math.hypot(halfL, halfW), static: true, ...extra };
}

export function crate(x, y, half, angle) {
    const mass = 70 * (2 * half) ** 2;
    const body = new Body({ mass, inertia: (mass * 8 * half * half) / 12 });
    body.pos = v2(x, y);
    body.angle = angle;
    return { kind: 'crate', body, halfL: half, halfW: half, radius: Math.SQRT2 * half };
}

const ROOFS = ['#7a5c58', '#5f6b7a', '#7d7466', '#5d7363', '#8a6f4e', '#6b5f78', '#787878'];
// Everyday cars get a random paint job; special vehicles keep their livery.
export function randomVehicle(mix, r) {
    const type = pickWeighted(mix, r);
    const recolor = type === 'sedan' || type === 'wagon' || type === 'classic';
    return new Car({ ...PRESETS[type], color: recolor ? randomCarColor(r) : PRESETS[type].color });
}

const CAR_COLORS = ['#e05d5d', '#5d9be0', '#e0c45d', '#d0d4da', '#6fcf8a', '#c27be0', '#e0905d', '#3c4450'];
export const randomCarColor = (r) => CAR_COLORS[Math.floor(r() * CAR_COLORS.length)];

export function buildCity(seed = 1996) {
    const r = rng(seed);
    const statics = [], crates = [], parked = [], blocks = [];

    // Boundary walls just outside the outer roads.
    const lo = -ROAD / 2 - 1, hi = N * PITCH + ROAD / 2 + 1, mid = (lo + hi) / 2, half = (hi - lo) / 2 + 1;
    statics.push(
        solid('wall', mid, lo, half, 1), solid('wall', mid, hi, half, 1),
        solid('wall', lo, mid, 1, half), solid('wall', hi, mid, 1, half),
    );

    for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
            const x0 = i * PITCH + ROAD / 2, x1 = (i + 1) * PITCH - ROAD / 2;
            const y0 = j * PITCH + ROAD / 2, y1 = (j + 1) * PITCH - ROAD / 2;
            const roll = r();
            const type = roll < 0.12 ? 'park' : roll < 0.26 ? 'lot' : 'houses';
            blocks.push({ x0, y0, x1, y1, type });
            const ix0 = x0 + SIDEWALK, iy0 = y0 + SIDEWALK, size = x1 - x0 - 2 * SIDEWALK;

            if (type === 'houses') {
                const lot = size / 2;
                for (let a = 0; a < 2; a++)
                    for (let b = 0; b < 2; b++) {
                        const lx = ix0 + a * lot, ly = iy0 + b * lot;
                        if (r() < 0.85) {
                            const hl = 4 + r() * (lot / 2 - 4.5), hw = 4 + r() * (lot / 2 - 4.5);
                            const cx = lx + lot / 2 + (r() - 0.5) * (lot - 2 * hl - 1);
                            const cy = ly + lot / 2 + (r() - 0.5) * (lot - 2 * hw - 1);
                            statics.push(solid('house', cx, cy, hl, hw, {
                                color: ROOFS[Math.floor(r() * ROOFS.length)],
                            }));
                        } else {
                            for (let k = 0, n = 2 + Math.floor(r() * 4); k < n; k++)
                                crates.push(crate(lx + 3 + r() * (lot - 6), ly + 3 + r() * (lot - 6), 0.5 + r() * 0.4, r() * 3));
                        }
                    }
            } else if (type === 'lot') {
                // Two rows of nose-in parking.
                for (const [y, ang] of [[iy0 + 3, Math.PI / 2], [iy0 + size - 3, -Math.PI / 2]])
                    for (let x = ix0 + 2; x < ix0 + size - 1; x += 3.2)
                        if (r() < 0.6) {
                            const car = randomVehicle(PARKING_MIX, r);
                            car.body.pos = v2(x, y);
                            car.body.angle = ang + (r() - 0.5) * 0.08;
                            parked.push(car);
                        }
                for (let k = 0; k < 4; k++)
                    crates.push(crate(ix0 + 4 + r() * (size - 8), iy0 + size / 2 + (r() - 0.5) * 6, 0.6, r() * 3));
            } else {
                for (let k = 0, n = 6 + Math.floor(r() * 6); k < n; k++)
                    statics.push(solid('tree', ix0 + 2 + r() * (size - 4), iy0 + 2 + r() * (size - 4), 0.5, 0.5, {
                        canopy: 1.8 + r() * 1.2,
                    }));
            }
        }

    // A few loose crates on the pavements.
    for (let k = 0; k < 25; k++) {
        const b = blocks[Math.floor(r() * blocks.length)];
        const side = Math.floor(r() * 4), t = r();
        const x = side < 2 ? b.x0 + t * (b.x1 - b.x0) : side === 2 ? b.x0 + 1.5 : b.x1 - 1.5;
        const y = side >= 2 ? b.y0 + t * (b.y1 - b.y0) : side === 0 ? b.y0 + 1.5 : b.y1 - 1.5;
        crates.push(crate(x, y, 0.5, r() * 3));
    }

    return { statics, crates, parked, blocks, rand: r };
}
