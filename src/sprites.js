// Vehicle sprites from the annotated atlases (see tools/atlas-editor.html).
//
// Each atlas is an image plus a JSON file describing its sprites: box,
// front direction, vehicle type and lamp positions. Sprites become "models"
// the game can put on a car: the sprite to draw, the car's real size in
// metres, the physics preset to drive like, and where its lamps are.
//
// Every sprite's size comes from its pixels, at the atlas's px-per-metre
// scale (measured from the "verified" sprites, the ones the editor has lamps
// on), so all vehicles are drawn at the same scale. Verified sprites take
// their axle layout and kind from their vehicle type; the rest get a physics
// preset picked by length.

const ATLASES = ['concept/vehicle-atlas-dr', 'concept/vehicle-atlas-e2'];
const ALPHA_CUT = 200;      // the atlases have soft coloured halos: drop anything fainter
const DEFAULT_PX_PER_M = 22; // if an atlas has no verified sprites to measure
const SKIP_KINDS = new Set(['tractor', 'trailer']); // articulated lorries: not driveable yet

const FRONT = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

// Physics preset for an unverified sprite, by length.
function presetForLength(len) {
    if (len < 4.9) return 'sedan';
    if (len < 5.4) return 'wagon';
    if (len < 6.4) return 'van';
    return 'lorry';
}
// Physics preset for a verified sprite's vehicle type.
const PRESET_OF_KIND = { car: 'sedan', van: 'van', bus: 'bus', lorry: 'lorry' };

export class VehicleSprites {
    constructor(models) {
        this.models = models;
        this.mode = 'all'; // 'all' | 'verified' | 'off'
    }

    get usable() {
        return this.mode === 'off' ? [] : this.models.filter((m) => this.mode === 'all' || m.verified);
    }

    // The most yellow car-sized verified sprite (the player's car is yellow).
    pickPlayer() {
        const cars = this.usable.filter((m) => m.preset === 'sedan' || m.preset === 'wagon');
        const yellow = ([r, g, b]) => Math.min(r, g) - b - Math.abs(r - g) * 0.5;
        return cars.sort((a, b) => (b.verified - a.verified) || yellow(b.colour) - yellow(a.colour))[0] ?? null;
    }

    // A model that drives like `preset` (falls back to any car-sized one).
    pick(preset, r = Math.random) {
        const pool = this.usable;
        if (!pool.length) return null;
        const same = pool.filter((m) => m.preset === preset);
        const list = same.length ? same : pool.filter((m) => m.preset === 'sedan' || m.preset === 'wagon');
        return (list.length ? list : pool)[Math.floor(r() * (list.length || pool.length))];
    }
}

export async function loadVehicleSprites() {
    const models = [];
    for (const base of ATLASES) {
        let doc;
        try {
            const res = await fetch(`${base}.json`, { cache: 'no-store' });
            if (!res.ok) continue;
            doc = await res.json();
        } catch { continue; }
        const image = await cleanImage(`${base.replace(/[^/]+$/, '')}${doc.atlas}`).catch(() => null);
        if (!image) continue;

        const lenPx = (s) => (s.front === 'up' || s.front === 'down' ? s.h : s.w);
        const widPx = (s) => (s.front === 'up' || s.front === 'down' ? s.w : s.h);
        const verified = (s) => s.lights?.length > 0 && doc.types[s.type];
        const scales = doc.sprites.filter(verified).map((s) => lenPx(s) / doc.types[s.type].length).sort((a, b) => a - b);
        const pxPerM = scales.length ? scales[scales.length >> 1] : DEFAULT_PX_PER_M;

        const pixels = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
        for (const s of doc.sprites) {
            const type = doc.types[s.type];
            if (type && SKIP_KINDS.has(type.kind)) continue;
            const v = !!verified(s);
            const length = lenPx(s) / pxPerM;
            const width = widPx(s) / pxPerM;
            const preset = v ? PRESET_OF_KIND[type.kind] ?? 'sedan' : presetForLength(length);
            const dims = { length, width };
            if (v) Object.assign(dims, { wheelbase: type.wheelbase, track: type.track });
            models.push({
                id: `${doc.atlas}#${s.id}`, image, box: s, front: FRONT[s.front],
                verified: v, preset, dims, lights: s.lights ?? [],
                colour: averageColour(pixels, image.width, s),
            });
        }
    }
    return new VehicleSprites(models);
}

// Mean colour of a sprite's opaque pixels (sampled), as [r, g, b].
function averageColour(px, w, s) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = s.y; y < s.y + s.h; y += 3)
        for (let x = s.x; x < s.x + s.w; x += 3) {
            const i = (y * w + x) * 4;
            if (px[i + 3] === 0) continue;
            r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
        }
    return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

// Load an atlas and remove the faint halo around every sprite.
async function cleanImage(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < d.data.length; i += 4) if (d.data[i] < ALPHA_CUT) d.data[i] = 0;
    g.putImageData(d, 0, 0);
    return c;
}

// Car config for a model: keep the preset's handling, take the size (and
// for verified sprites the axle layout) from the sprite. Wheelbase and track
// scale with the body for unverified ones.
export function modelConfig(model, preset) {
    const { length, width, wheelbase, track } = model.dims;
    return {
        length, width,
        wheelbase: wheelbase ?? preset.wheelbase * (length / preset.length),
        track: track ?? Math.min(width - 0.3, preset.track * (width / preset.width)),
    };
}

// Draw a model's sprite filling the car's body. Call in the car's local frame
// (x forward, y left, metres), so the sprite's front lines up with the car's.
export function drawSprite(ctx, model, length, width) {
    const { box: s, front: f, image } = model;
    const left = { x: f.y, y: -f.x };                      // vehicle's left, in image pixels
    const lenPx = f.y ? s.h : s.w, widPx = f.y ? s.w : s.h;
    const kx = length / lenPx, ky = width / widPx;          // metres per pixel along / across
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    ctx.save();
    // image px (relative to the sprite centre) -> car-local metres
    ctx.transform(f.x * kx, left.x * ky, f.y * kx, left.y * ky, -(f.x * cx + f.y * cy) * kx, -(left.x * cx + left.y * cy) * ky);
    ctx.drawImage(image, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
    ctx.restore();
}
