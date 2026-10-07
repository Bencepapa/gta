// 2D vector helpers. Units: metres, seconds, radians. +y is "up" in world space.
export const v2 = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => v2(a.x + b.x, a.y + b.y);
export const sub = (a, b) => v2(a.x - b.x, a.y - b.y);
export const mul = (a, s) => v2(a.x * s, a.y * s);
export const dot = (a, b) => a.x * b.x + a.y * b.y;
// Scalar z of the 3D cross product (a.x, a.y, 0) x (b.x, b.y, 0).
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const fromAngle = (a) => v2(Math.cos(a), Math.sin(a));
export const perp = (a) => v2(-a.y, a.x);
export const rot = (a, angle) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return v2(c * a.x - s * a.y, s * a.x + c * a.y);
};
