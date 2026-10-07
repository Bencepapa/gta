// Vehicle presets and the tunable-parameter schema used by the debug panel.
// A preset is plain JSON: copy one out of the panel, tweak, paste it back,
// or add it to PRESETS below to make it a permanent vehicle type.

export const PARAMS = [
    { group: 'Body' },
    { key: 'length', label: 'Length', unit: 'm', min: 2.5, max: 14, step: 0.1 },
    { key: 'width', label: 'Width', unit: 'm', min: 1.4, max: 3, step: 0.05 },
    { key: 'mass', label: 'Mass', unit: 'kg', min: 300, max: 20000, step: 50 },
    { key: 'wheelbase', label: 'Wheelbase', unit: 'm', min: 1.5, max: 9, step: 0.05, help: 'Front-to-rear axle distance. Longer = wider turning circle.' },
    { key: 'track', label: 'Track', unit: 'm', min: 1, max: 2.6, step: 0.05, help: 'Left-to-right wheel distance.' },

    { group: 'Engine' },
    { key: 'engineForce', label: 'Engine force', unit: 'N', min: 1000, max: 60000, step: 250, help: 'Push at full throttle. Acceleration = force / mass.' },
    { key: 'brakeForce', fallback: 'engineForce', label: 'Brake force', unit: 'N', min: 1000, max: 120000, step: 250, help: 'Stopping force when pressing against the direction of travel. Deceleration = force / mass. Unset = same as engine force.' },
    { key: 'maxSpeedKmh', label: 'Speed limiter', unit: 'km/h', min: 0, max: 400, step: 5, help: '0 = off; top speed is then where engine force equals rolling drag.' },
    { key: 'reverseScale', label: 'Reverse power', unit: '×', min: 0.1, max: 1, step: 0.05 },

    { group: 'Steering & grip' },
    { key: 'maxSteer', label: 'Max steer angle', unit: 'rad', min: 0.1, max: 1, step: 0.01 },
    { key: 'rollingDamping', label: 'Rolling drag / tyre', unit: 'N·s/m', min: 2, max: 600, step: 0.5, help: 'Resistance along the wheel. Sets coasting slowdown and top speed.' },
    { key: 'lateralDamping', label: 'Side grip / tyre', unit: 'N·s/m', min: 50, max: 15000, step: 25, help: 'Resistance to sliding sideways. Lower relative to mass = more drift.' },

    { group: 'Driver (AI)' },
    { key: 'ruleBreak', default: 0, label: 'Breaks rules', unit: '×', min: 0, max: 1, step: 0.01, help: 'Chance an AI driver of this vehicle ignores the lights and give-way rules at a junction (still brakes for cars in its way).' },
    { key: 'courtesy', default: 0.25, label: 'Gives up right', unit: '×', min: 0, max: 1, step: 0.05, help: 'Chance an AI driver of this vehicle lets others go first at a junction (flashing the headlights). Big, slow vehicles do it more.' },

    { group: 'Handbrake & skids' },
    { key: 'handbrakeRollingMul', label: 'Rear brake drag', unit: '×', min: 1, max: 20, step: 0.25 },
    { key: 'handbrakeLateralMul', label: 'Rear grip kept', unit: '×', min: 0, max: 1, step: 0.01, help: 'Fraction of rear side grip left while the handbrake is held.' },
    { key: 'gripRecoveryTime', label: 'Grip recovery', unit: 's', min: 0.01, max: 2, step: 0.01 },
    { key: 'skidOn', label: 'Skid marks start', unit: 'm/s', min: 0.2, max: 8, step: 0.05, help: 'Rear-wheel sideways speed at which skid marks begin.' },
    { key: 'skidOff', label: 'Skid marks stop', unit: 'm/s', min: 0.1, max: 8, step: 0.05 },
];

export const PRESETS = {
    // The 1996 prototype's numbers, unchanged. Kept as the reference.
    original: {
        name: 'Original (1996)', style: 'car', color: '#8ce6c5',
        length: 4, width: 2, mass: 1000, wheelbase: 2.7, track: 1.4,
        engineForce: 9750, maxSpeedKmh: 0, reverseScale: 0.75,
        maxSteer: 0.55, rollingDamping: 32.5, lateralDamping: 1100,
        handbrakeRollingMul: 6.25, handbrakeLateralMul: 0.3625, gripRecoveryTime: 0.15,
        skidOn: 1.5 / 0.7, skidOff: 0.8 / 0.7,
    },
    // Same car, retuned for more grip, stronger braking and easier handling.
    classic: {
        name: 'Classic', style: 'car', color: '#ffd23f',
        length: 4, width: 2, mass: 1000, wheelbase: 2.7, track: 1.4,
        engineForce: 18000, maxSpeedKmh: 0, reverseScale: 0.75,
        maxSteer: 0.55, rollingDamping: 108.5, lateralDamping: 2950,
        handbrakeRollingMul: 6.25, handbrakeLateralMul: 0.3625, gripRecoveryTime: 0.15,
        courtesy: 0.2, skidOn: 2.1429, skidOff: 1.1429,
    },
    sport: {
        name: 'Sports car', style: 'sport', color: '#e0412f',
        length: 4.3, width: 1.95, mass: 1250, wheelbase: 2.6, track: 1.6,
        engineForce: 40000, maxSpeedKmh: 280, reverseScale: 0.6,
        maxSteer: 0.5, rollingDamping: 178, lateralDamping: 3525,
        handbrakeRollingMul: 6, handbrakeLateralMul: 0.3, gripRecoveryTime: 0.2,
        ruleBreak: 0.08, courtesy: 0.1, skidOn: 2.6, skidOff: 1.4,
    },
    sedan: {
        name: 'Saloon', style: 'car', color: '#5d9be0',
        length: 4.6, width: 1.9, mass: 1400, wheelbase: 2.75, track: 1.55,
        engineForce: 10500, maxSpeedKmh: 190, brakeForce: 14000, reverseScale: 0.7,
        maxSteer: 0.52, rollingDamping: 40, lateralDamping: 1450,
        handbrakeRollingMul: 6, handbrakeLateralMul: 0.35, gripRecoveryTime: 0.2,
        courtesy: 0.25, skidOn: 2.2, skidOff: 1.2,
    },
    wagon: {
        name: 'Family wagon', style: 'wagon', color: '#a3a86a',
        length: 4.9, width: 1.95, mass: 1650, wheelbase: 2.85, track: 1.55,
        engineForce: 15250, maxSpeedKmh: 170, reverseScale: 0.7,
        maxSteer: 0.54, rollingDamping: 145.5, lateralDamping: 2250,
        handbrakeRollingMul: 5, handbrakeLateralMul: 0.4, gripRecoveryTime: 0.25,
        courtesy: 0.3, skidOn: 2, skidOff: 1.1,
    },
    van: {
        name: 'Van', style: 'van', color: '#e8e8e8',
        length: 5.4, width: 2.1, mass: 2400, wheelbase: 3.3, track: 1.7,
        engineForce: 12500, maxSpeedKmh: 140, brakeForce: 22000, reverseScale: 0.7,
        maxSteer: 0.5, rollingDamping: 75, lateralDamping: 2300,
        handbrakeRollingMul: 4.5, handbrakeLateralMul: 0.45, gripRecoveryTime: 0.3,
        courtesy: 0.45, skidOn: 1.8, skidOff: 1,
    },
    bus: {
        name: 'Bus', style: 'bus', color: '#e3a92b',
        length: 11.5, width: 2.55, mass: 11000, wheelbase: 6.4, track: 2.05,
        engineForce: 33000, maxSpeedKmh: 90, brakeForce: 60000, reverseScale: 0.5,
        maxSteer: 0.62, rollingDamping: 330, lateralDamping: 10500,
        handbrakeRollingMul: 3, handbrakeLateralMul: 0.6, gripRecoveryTime: 0.5,
        courtesy: 0.65, skidOn: 1.4, skidOff: 0.8,
    },
    lorry: {
        name: 'Lorry', style: 'lorry', color: '#4a6fa5',
        length: 9, width: 2.5, mass: 8000, wheelbase: 5.2, track: 2,
        engineForce: 26000, maxSpeedKmh: 100, brakeForce: 45000, reverseScale: 0.5,
        maxSteer: 0.6, rollingDamping: 240, lateralDamping: 7800,
        handbrakeRollingMul: 3, handbrakeLateralMul: 0.55, gripRecoveryTime: 0.45,
        courtesy: 0.55, skidOn: 1.4, skidOff: 0.8,
    },
};

// Relative chance of each type appearing in AI traffic / parking lots.
export const TRAFFIC_MIX = { sedan: 5, wagon: 3, sport: 1.5, van: 2, classic: 1, lorry: 1, bus: 0.7 };
export const PARKING_MIX = { sedan: 5, wagon: 3, sport: 1.5, van: 1.5, classic: 1 };

export function pickWeighted(mix, r) {
    const total = Object.values(mix).reduce((a, b) => a + b, 0);
    let x = r() * total;
    for (const [k, w] of Object.entries(mix)) if ((x -= w) <= 0) return k;
    return Object.keys(mix)[0];
}

// Derived figures shown in the panel.
export function stats(cfg) {
    const dragTop = cfg.engineForce / (4 * cfg.rollingDamping); // m/s where engine = rolling drag
    const top = cfg.maxSpeedKmh > 0 ? Math.min(dragTop, cfg.maxSpeedKmh / 3.6) : dragTop;
    // 0-100 km/h with linear drag: v(t) = vT(1 - e^(-t k/m)), k = 4*rolling.
    const k = 4 * cfg.rollingDamping, v100 = 100 / 3.6;
    const t100 = v100 < dragTop ? (-cfg.mass / k) * Math.log(1 - v100 / dragTop) : Infinity;
    return {
        topKmh: top * 3.6,
        zeroTo100: t100,
        accel: cfg.engineForce / cfg.mass,
        gripPerTonne: (cfg.lateralDamping * 4) / (cfg.mass / 1000),
        turnRadius: cfg.wheelbase / Math.tan(cfg.maxSteer),
        brake100: brakingDistance(cfg, 100 / 3.6),
    };
}

// Distance to stop from v with brake force plus rolling drag (a + b·v deceleration).
export function brakingDistance(cfg, v) {
    const a = (cfg.brakeForce ?? cfg.engineForce) / cfg.mass, b = (4 * cfg.rollingDamping) / cfg.mass;
    return v / b - (a / (b * b)) * Math.log(1 + (b * v) / a);
}
