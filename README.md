# gta

A top-down 2D driving sandbox in plain JavaScript (no build step): a small
city with roads, junctions, traffic lights and AI traffic, driven by a
simple rigid-body car model.

The car model is based on Pat Kerr's 1996 2D vehicle physics prototype, the
idea behind the original GTA's handling: each tyre is a velocity-proportional
damper, weak along the wheel and strong sideways. See his write-up and
recreation at <https://patkerr.co.uk/2d-vehicles/>. This is an independent
reimplementation, not affiliated with Rockstar Games, Take-Two or Pat Kerr.

**▶ Play online: <https://bencepapa.github.io/gta/>**

## Run locally

ES modules need a web server (opening `index.html` directly fails):

```
python serve.py
```

then open <http://localhost:5173>.

## Controls

| Key | |
|---|---|
| W/S or ↑/↓ | throttle / brake / reverse |
| A/D or ←/→ | steer |
| Space | handbrake |
| Q / E | left / right indicator |
| Tab | hazard lights |
| H / R (hold) | horn / headlights |
| F | take the nearest car |
| Z | steering assist |
| X | speed zoom |
| ` | debug menu (traffic, vehicle tuning, JSON presets) |

On phones and tablets, on-screen controls appear on the first touch: a
steering wheel (its hub is the horn), gas, brake (hold to reverse) and
handbrake, plus indicators, hazards and a headlight-flash button. Add
`?touch=1` to the URL to show them on a desktop.

## Code

- `src/car.js`, `src/body.js` – car and rigid-body physics
- `src/vehicles.js` – vehicle presets (car, sports car, wagon, van, bus, lorry)
- `src/city.js` – the city layout
- `src/ai.js`, `src/junctions.js` – AI drivers and junction rules
- `src/collide.js` – box collisions
- `src/main.js` – game loop and rendering
