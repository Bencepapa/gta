// On-screen controls for touch screens: a steering wheel (drag to turn, the
// hub is the horn), gas and brake pedals, a handbrake, and a dashboard row
// with the indicators, hazards and headlight flash.
//
// Shown automatically on the first touch, or with ?touch=1 in the URL.
// The game reads `state` each frame; light toggles go through callbacks.

const WHEEL_LOCK = 120; // degrees of wheel rotation for full steering lock
const SPRING = 10;      // how fast the wheel recentres when let go (1/s)

const el = (tag, cls, html = '') => {
    const e = document.createElement(tag);
    e.className = cls;
    e.innerHTML = html;
    return e;
};

// Keep getting a finger's events even when it slides off the control.
function capture(target, id) {
    try { target.setPointerCapture(id); } catch { /* not a real pointer: ignore */ }
}

export class TouchControls {
    // hooks: { toggleSignal(which), getSignal(), hornStart(), hornStop() }
    constructor(hooks) {
        this.hooks = hooks;
        this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, flash: false, horn: false };
        this.active = false;
        this.wheelAngle = 0; // degrees, clockwise positive
        this.build();
        const forced = new URLSearchParams(location.search).get('touch') === '1';
        if (forced) this.show();
        else addEventListener('touchstart', () => this.show(), { once: true, passive: true });
        let last = performance.now();
        const tick = (t) => {
            this.recentre(Math.min(0.05, (t - last) / 1000));
            last = t;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    show() {
        if (this.active) return;
        this.active = true;
        this.root.hidden = false;
        document.body.classList.add('touch');
    }

    build() {
        const root = (this.root = el('div', 'touch-ui'));
        root.hidden = true;
        // Long presses must not select text or open menus.
        root.addEventListener('contextmenu', (e) => e.preventDefault());

        // ---- steering wheel ----
        this.wheel = el('div', 'touch-wheel', `
            <svg viewBox="-100 -100 200 200" aria-hidden="true">
                <circle r="88" class="rim"/>
                <path d="M-84 0 L-26 0 M26 0 L84 0 M0 26 L0 86" class="spoke"/>
                <circle r="30" class="hub"/>
                <rect x="-6" y="-97" width="12" height="16" rx="3" class="mark"/>
                <text y="7" class="hub-label">HORN</text>
            </svg>`);
        this.wheel.setAttribute('role', 'slider');
        this.wheel.setAttribute('aria-label', 'Steering wheel');
        this.bindWheel(this.wheel);

        // ---- pedals + handbrake ----
        const pedals = el('div', 'touch-pedals');
        const brake = el('button', 'touch-btn pedal brake', 'BRAKE<small>hold to reverse</small>');
        const gas = el('button', 'touch-btn pedal gas', 'GAS');
        const hb = el('button', 'touch-btn handbrake', 'HAND<br>BRAKE');
        this.hold(gas, (on) => (this.state.throttle = on ? 1 : 0));
        this.hold(brake, (on) => (this.state.brake = on ? 1 : 0));
        this.hold(hb, (on) => (this.state.handbrake = on));
        const left = el('div', 'touch-col');
        left.append(hb, brake);
        pedals.append(left, gas);

        // ---- dashboard: indicators, hazards, headlight flash ----
        const dash = el('div', 'touch-dash');
        this.btnLeft = el('button', 'touch-btn sig', '◀');
        this.btnHaz = el('button', 'touch-btn haz', '⚠');
        this.btnRight = el('button', 'touch-btn sig', '▶');
        const flash = el('button', 'touch-btn flash', '💡');
        this.btnLeft.setAttribute('aria-label', 'Left indicator');
        this.btnHaz.setAttribute('aria-label', 'Hazard lights');
        this.btnRight.setAttribute('aria-label', 'Right indicator');
        flash.setAttribute('aria-label', 'Flash headlights');
        this.tap(this.btnLeft, () => this.hooks.toggleSignal('left'));
        this.tap(this.btnHaz, () => this.hooks.toggleSignal('hazard'));
        this.tap(this.btnRight, () => this.hooks.toggleSignal('right'));
        this.hold(flash, (on) => (this.state.flash = on));
        dash.append(this.btnLeft, this.btnHaz, this.btnRight, flash);

        root.append(this.wheel, pedals, dash);
        document.body.append(root);
    }

    // A button that is "on" while a finger is on it (several can be held at once).
    hold(btn, set) {
        btn.type = 'button';
        const on = (e) => {
            e.preventDefault();
            capture(btn, e.pointerId);
            btn.classList.add('down');
            set(true);
        };
        const off = () => {
            btn.classList.remove('down');
            set(false);
        };
        btn.addEventListener('pointerdown', on);
        btn.addEventListener('pointerup', off);
        btn.addEventListener('pointercancel', off);
        btn.addEventListener('lostpointercapture', off);
    }

    tap(btn, action) {
        btn.type = 'button';
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            action();
        });
    }

    bindWheel(wheel) {
        let grab = null; // { id, lastAngle } while a finger turns the wheel
        const angleOf = (e) => {
            const r = wheel.getBoundingClientRect();
            return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
        };
        wheel.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            capture(wheel, e.pointerId);
            const r = wheel.getBoundingClientRect();
            const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
            if (Math.hypot(dx, dy) < r.width * 0.17) { // the hub: horn
                this.state.horn = true;
                wheel.classList.add('honk');
                this.hooks.hornStart();
                grab = { id: e.pointerId, horn: true };
                return;
            }
            grab = { id: e.pointerId, lastAngle: angleOf(e) };
        });
        wheel.addEventListener('pointermove', (e) => {
            if (!grab || grab.horn || e.pointerId !== grab.id) return;
            const a = angleOf(e);
            let d = a - grab.lastAngle;
            if (d > 180) d -= 360; // unwrap across ±180°
            if (d < -180) d += 360;
            grab.lastAngle = a;
            this.setWheel(this.wheelAngle + d);
        });
        const release = (e) => {
            if (!grab || e.pointerId !== grab.id) return;
            if (grab.horn) {
                this.state.horn = false;
                wheel.classList.remove('honk');
                this.hooks.hornStop();
            }
            grab = null;
        };
        wheel.addEventListener('pointerup', release);
        wheel.addEventListener('pointercancel', release);
        wheel.addEventListener('lostpointercapture', release);
        this.wheelHeld = () => !!grab && !grab.horn;
    }

    setWheel(deg) {
        this.wheelAngle = Math.max(-WHEEL_LOCK, Math.min(WHEEL_LOCK, deg));
        // Clockwise = turn right; the game's steer is + for left.
        this.state.steer = -this.wheelAngle / WHEEL_LOCK;
        this.wheel.firstElementChild.style.transform = `rotate(${this.wheelAngle}deg)`;
        this.wheel.setAttribute('aria-valuenow', Math.round(this.state.steer * -100));
    }

    // Let go of the wheel and it turns back to the centre; also keeps the
    // dashboard buttons in step with the car's lights.
    recentre(dt) {
        if (!this.active) return;
        if (!this.wheelHeld?.() && this.wheelAngle !== 0) {
            const a = this.wheelAngle * Math.exp(-SPRING * dt);
            this.setWheel(Math.abs(a) < 0.5 ? 0 : a);
        }
        const sig = this.hooks.getSignal();
        this.btnLeft.classList.toggle('on', sig === 'left');
        this.btnRight.classList.toggle('on', sig === 'right');
        this.btnHaz.classList.toggle('on', sig === 'hazard');
    }
}
