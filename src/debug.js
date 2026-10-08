import { PARAMS, PRESETS, stats } from './vehicles.js';

const STORE = 'gta.customPresets';
const loadCustom = () => {
    try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
};
const saveCustom = (p) => {
    try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { /* private mode etc. */ }
};

const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat());
    return el;
};

const decimals = (step) => (String(step).split('.')[1] ?? '').length;

// api: { getCar(), applyCar(cfg), getTraffic(), setTraffic(n), maxTraffic,
//        getOption(name), setOption(name, value) }
export function createDebugPanel(api) {
    let custom = loadCustom();
    const allPresets = () => ({ ...PRESETS, ...custom });

    // ---------- toggle ----------
    const toggle = h('button', {
        id: 'debug-toggle', type: 'button', 'aria-label': 'Debug menu',
        'aria-expanded': 'false', 'aria-controls': 'debug-panel',
    }, h('span'), h('span'), h('span'));
    const panel = h('aside', { id: 'debug-panel', 'aria-label': 'Debug menu', hidden: true });
    const setOpen = (open) => {
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) refresh();
    };
    toggle.addEventListener('click', () => setOpen(panel.hidden));
    addEventListener('keydown', (e) => {
        if (e.code === 'Backquote' && !isTyping(e.target)) setOpen(panel.hidden);
    });

    // Sliders keep focus after a mouse drag, which would swallow the arrow
    // keys; hand focus back to the game once the pointer is released.
    panel.addEventListener('pointerup', (e) => {
        if (e.target.matches('input[type=range], input[type=checkbox], button')) e.target.blur();
    });

    // ---------- slider + number pair ----------
    // inputMax: the number box may go beyond the slider's range.
    function slider({ label, min, max, step, unit = '', help, inputMax = max }, get, set) {
        const range = h('input', { type: 'range', min, max, step });
        const num = h('input', { type: 'number', min, max: inputMax, step, 'aria-label': label });
        const d = decimals(step);
        const show = (v) => { range.value = v; num.value = Number(v).toFixed(d); };
        range.addEventListener('input', () => { num.value = Number(range.value).toFixed(d); set(Number(range.value)); });
        num.addEventListener('change', () => {
            const v = Number(num.value);
            if (!Number.isFinite(v)) return show(get());
            range.value = v; // the range clamps, the number box may go beyond
            set(v);
        });
        const row = h('label', { class: 'row', title: help ?? '' },
            h('span', { class: 'lbl' }, label, unit && h('small', {}, ` ${unit}`)), range, num);
        return { row, sync: () => show(get()) };
    }

    // ---------- world ----------
    const syncers = [];
    const traffic = slider({ label: 'AI traffic', min: 0, max: api.maxTraffic, step: 1, unit: 'cars',
        help: 'Cars stop being added once the roads are full. Lots of traffic lowers the frame rate on slower machines.' },
        api.getTraffic, (n) => api.setTraffic(Math.round(n)));
    // Asked for more than fit on the roads?
    const trafficNote = h('div', { class: 'stats' });
    setInterval(() => {
        const want = api.getTrafficWanted?.() ?? 0, have = api.getTraffic();
        trafficNote.textContent = want > have ? `${have} of ${want} placed (roads are full)` : '';
    }, 500);
    const timeScale = slider({ label: 'Time scale', min: 0.1, max: 2, step: 0.05, unit: '×' },
        () => api.getOption('timeScale'), (v) => api.setOption('timeScale', v));
    const zoomBox = h('input', { type: 'checkbox' });
    zoomBox.addEventListener('change', () => api.setOption('speedZoom', zoomBox.checked));
    const spriteSel = h('select', { 'aria-label': 'Vehicle sprites' },
        h('option', { value: 'all' }, 'all atlas sprites'),
        h('option', { value: 'verified' }, 'only marked-up ones (with lamps)'),
        h('option', { value: 'off' }, 'off (plain shapes)'));
    spriteSel.addEventListener('change', () => { api.setOption('sprites', spriteSel.value); spriteSel.blur(); });
    syncers.push(() => (spriteSel.value = api.getOption('sprites') ?? 'off'));
    const aiBox = h('input', { type: 'checkbox' });
    aiBox.addEventListener('change', () => api.setOption('showAI', aiBox.checked));
    syncers.push(traffic.sync, timeScale.sync, () => (zoomBox.checked = api.getOption('speedZoom')),
        () => (aiBox.checked = api.getOption('showAI')));

    // ---------- steering assist ----------
    const assistBox = h('input', { type: 'checkbox' });
    assistBox.addEventListener('change', () => api.setOption('assist', assistBox.checked));
    syncers.push(() => (assistBox.checked = api.getOption('assist')));
    const assistRows = [
        { key: 'assistAngle', label: 'Max angle', unit: '°', min: 1, max: 45, step: 1, help: 'Only align when the car is within this angle of the road.' },
        { key: 'assistStrength', label: 'Strength', unit: '×', min: 0.1, max: 2, step: 0.05, help: 'How hard the assist steers back to the road heading.' },
        { key: 'tapTime', label: 'Tap length', unit: 's', min: 0.05, max: 1, step: 0.01, help: 'Steering held shorter than this counts as a nudge; longer gives full manual control.' },
        { key: 'tapScale', label: 'Tap strength', unit: '×', min: 0.1, max: 1, step: 0.05, help: 'Steering input is scaled by this during a nudge.' },
    ].map((p) => {
        const s = slider(p, () => api.getOption(p.key), (v) => api.setOption(p.key, v));
        syncers.push(s.sync);
        return s.row;
    });

    // ---------- vehicle ----------
    const presetSel = h('select', { 'aria-label': 'Vehicle preset' });
    const fillPresets = () => {
        presetSel.replaceChildren(
            h('option', { value: '' }, '— choose —'),
            ...Object.entries(allPresets()).map(([k, p]) =>
                h('option', { value: k }, (custom[k] ? '★ ' : '') + (p.name ?? k))),
        );
    };
    presetSel.addEventListener('change', () => {
        const p = allPresets()[presetSel.value];
        // Presets replace optional fields too (no brakeForce = brake with the engine).
        if (p) { api.applyCar({ brakeForce: undefined, courtesy: undefined, ...p }); refresh(); }
        presetSel.blur();
    });
    const color = h('input', { type: 'color', 'aria-label': 'Paint colour' });
    color.addEventListener('input', () => { api.applyCar({ color: color.value }); writeJson(); });

    const statsBox = h('div', { class: 'stats' });
    const paramRows = [];
    for (const p of PARAMS) {
        if (p.group) { paramRows.push(h('h3', {}, p.group)); continue; }
        const s = slider(p, () => api.getCar().cfg[p.key] ?? api.getCar().cfg[p.fallback] ?? p.default, (v) => { api.applyCar({ [p.key]: v }); writeJson(); showStats(); });
        syncers.push(s.sync);
        paramRows.push(s.row);
    }

    // ---------- JSON ----------
    const json = h('textarea', { spellcheck: 'false', rows: 10, 'aria-label': 'Vehicle JSON' });
    const status = h('span', { class: 'status', role: 'status' });
    const flash = (msg) => { status.textContent = msg; clearTimeout(flash.t); flash.t = setTimeout(() => (status.textContent = ''), 2500); };
    const nameBox = h('input', { type: 'text', placeholder: 'preset name', 'aria-label': 'Preset name' });

    function writeJson() {
        if (document.activeElement !== json) json.value = JSON.stringify(api.getCar().cfg, round, 2);
    }
    function showStats() {
        const s = stats(api.getCar().cfg);
        statsBox.textContent =
            `top ${s.topKmh.toFixed(0)} km/h · 0-100 ${Number.isFinite(s.zeroTo100) ? s.zeroTo100.toFixed(1) + ' s' : 'never'} · ` +
            `accel ${s.accel.toFixed(1)} m/s² · 100→0 in ${s.brake100.toFixed(0)} m · grip ${s.gripPerTonne.toFixed(0)}/t · turn r ${s.turnRadius.toFixed(1)} m`;
    }
    const buttons = h('div', { class: 'btns' },
        h('button', { type: 'button', onclick: async () => {
            try { await navigator.clipboard.writeText(json.value); flash('Copied'); }
            catch { json.select(); flash('Select + Ctrl+C to copy'); }
        } }, 'Copy JSON'),
        h('button', { type: 'button', onclick: () => {
            try {
                const cfg = JSON.parse(json.value);
                if (typeof cfg !== 'object' || !cfg) throw new Error('not an object');
                api.applyCar(cfg);
                json.blur();
                refresh();
                flash('Applied');
            } catch (err) { flash(`Invalid JSON: ${err.message}`); }
        } }, 'Apply JSON'),
    );
    const saveRow = h('div', { class: 'btns' }, nameBox,
        h('button', { type: 'button', onclick: () => {
            const name = nameBox.value.trim();
            if (!name) return flash('Enter a name first');
            const key = 'custom:' + name.toLowerCase().replace(/\s+/g, '-');
            custom[key] = { ...api.getCar().cfg, name };
            saveCustom(custom);
            api.applyCar({ name });
            fillPresets();
            presetSel.value = key;
            writeJson();
            flash(`Saved “${name}”`);
        } }, 'Save preset'),
        h('button', { type: 'button', onclick: () => {
            if (!custom[presetSel.value]) return flash('Pick a ★ preset to delete');
            delete custom[presetSel.value];
            saveCustom(custom);
            fillPresets();
            flash('Deleted');
        } }, 'Delete'),
    );

    panel.append(
        h('h2', {}, 'Debug'),
        h('section', {}, h('h3', {}, 'World'), traffic.row, trafficNote,
            h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Vehicle sprites'), spriteSel), timeScale.row,
            h('label', { class: 'row check' }, zoomBox, h('span', {}, 'Speed zoom')),
            h('label', { class: 'row check' }, aiBox, h('span', {}, 'Show AI state labels')),
            h('ul', { class: 'legend' },
                h('li', { style: '--c:#e86bff' }, 'red light / give way / give way (right) / give way (turning left) / junction busy: stopped at a junction by the traffic rules; letting others go: gave up its right (flashed headlights)'),
                h('li', { style: '--c:#46d27a' }, 'driving: following its lane'),
                h('li', { style: '--c:#ffb020' }, 'waiting: something ahead (seconds = how long it has been blocked by something that isn’t moving; backs out after ~2–4 s)'),
                h('li', { style: '--c:#ff8a3d' }, 'stuck: throttle on but not moving; backs out after 2 s'),
                h('li', { style: '--c:#ff4d4d' }, 'reversing: backing out; after 3 tries it turns round'),
                h('li', { style: '--c:#4da3ff' }, 'detour: going round the obstacle in the other lane'))),
        h('section', {}, h('h3', {}, 'Steering assist'),
            h('label', { class: 'row check', title: 'Lines the car up with the road after small corrections. [Z]' },
                assistBox, h('span', {}, 'Align to road')), ...assistRows),
        h('section', {}, h('h3', {}, 'Your vehicle'),
            h('div', { class: 'btns' }, presetSel, color), statsBox, ...paramRows),
        h('section', {}, h('h3', {}, 'Vehicle JSON'), json, buttons, saveRow, status),
    );
    document.body.append(toggle, panel);

    function refresh() {
        if (panel.hidden) return;
        for (const s of syncers) s();
        color.value = api.getCar().cfg.color;
        writeJson();
        showStats();
    }
    fillPresets();
    // Traffic count can change on its own (taking over an AI car), so poll lightly.
    setInterval(() => { if (!panel.hidden && document.activeElement?.closest?.('#debug-panel') == null) traffic.sync(); }, 500);
    return { refresh };
}

function round(_k, v) {
    return typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(4)) : v;
}

export function isTyping(el) {
    return !!el?.closest?.('input, textarea, select');
}
