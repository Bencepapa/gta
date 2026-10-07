// Uniform grid for "what's near me?" queries, rebuilt every tick. With
// hundreds of cars, checking everyone against everyone is the slow part.
export class SpatialGrid {
    constructor(cell = 24) {
        this.cell = cell;
        this.map = new Map();
    }

    rebuild(items) {
        this.map.clear();
        for (const it of items) this.insert(it);
    }

    insert(it) {
        const c = this.cell;
        const k = Math.floor(it.body.pos.x / c) * 65536 + Math.floor(it.body.pos.y / c);
        let list = this.map.get(k);
        if (!list) this.map.set(k, (list = []));
        list.push(it);
    }

    // Everything in the cells overlapping a square of half-size r around p.
    near(p, r) {
        const c = this.cell, out = [];
        const x0 = Math.floor((p.x - r) / c), x1 = Math.floor((p.x + r) / c);
        const y0 = Math.floor((p.y - r) / c), y1 = Math.floor((p.y + r) / c);
        for (let x = x0; x <= x1; x++)
            for (let y = y0; y <= y1; y++) {
                const list = this.map.get(x * 65536 + y);
                if (list) for (const it of list) out.push(it);
            }
        return out;
    }
}
