# Porting the heatmap layer into another app

The editor and the heat layer are separate. To get the effect somewhere else you do
**not** need the viewer, the panel or any of the UI — those are ~1500 lines you should
leave behind.

## What to copy

Two files, ~700 lines total, **zero DOM references**:

```
src/heatmap.js     the layer: shader injection, uniforms, points, serialization
src/gradient.js    color ramp and presets (heatmap.js imports it)
```

Their only external dependency is `three` itself. Nothing else in this repo is
required.

## Minimal integration

```js
import { HeatmapLayer } from './heatmap.js';

const heat = new HeatmapLayer();

// A plain model with no green zone map: turn the chroma key off, or it will try to
// key against your texture and paint garbage. See "Zones" below.
heat.set('zoneOn', false);
heat.set('desat', 0);
heat.set('gridOn', false);
heat.set('blend', 2);        // 2 = flat color over the texture

// Patch every material you want the heat to appear on
model.traverse((o) => {
  if (o.isMesh) {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => heat.attach(m));
  }
});

// Coordinates are in the MESH'S LOCAL SPACE and radius is in model units
heat.addPoint({ x: 0, y: 1.4, z: 0.2, radius: 0.3, weight: 1, level: 1 });
```

That is the whole integration. No render loop hook is needed: the layer is static
unless you move points, and `addPoint` / `removePoint` / `set` already push to the
uniforms.

If you mutate a point object directly, call `heat.sync()` afterwards.

## The five things that actually break it

In rough order of how often they are the cause.

### 1. The chroma key is on by default

`HeatmapLayer` ships configured for **this** project, where the model's texture is a
green mask marking where the heat may show. The defaults are `zoneOn: true` and
`zoneUseBase: true`, which means it samples your base texture looking for green.

On any normal model that produces nonsense: the mask comes out arbitrary and the
result looks nothing like the demo.

```js
heat.set('zoneOn', false);   // do this first, always, unless you have a green map
```

Same for `desat`, which defaults to `0.8` because this model's texture is a rainbow.
On a normal model that just washes out your colors: set it to `0`.

### 2. Coordinates are in raw local space, not world space

The shader reads the vertex `position` attribute directly. That is the mesh's local
space **before any node transform**.

If your model sits inside a parent with a scale or offset, or its origin is at the
feet rather than the center, your points will land somewhere unexpected.

Two ways out:

- **Express the points in that same raw local space.** To convert from a world point:
  `mesh.worldToLocal(worldPoint.clone())`.
- **Or flatten the model first**, which is what the viewer here does: bake each mesh's
  world matrix into its geometry, then recenter. See `load()` in `src/viewer.js`; it is
  about 20 lines and makes local space equal world space.

### 3. Radius is in model units

`radius: 0.3` on a model 2 units tall covers a shoulder. On a model 180 units tall it
is invisible. Scale accordingly, or normalize your model.

A good starting radius is roughly 10–20% of the model's bounding box diagonal.

### 4. It only patches MeshStandardMaterial / MeshPhysicalMaterial

`attach()` injects into `#include <map_fragment>` and `#include <metalnessmap_fragment>`.
Those chunks only exist in the standard/physical shaders. On `MeshBasicMaterial`,
`MeshLambertMaterial`, `ShaderMaterial` or anything custom, the replacement silently
does nothing and you get no heat at all — with no error.

### 5. three version

Tested on **r185**. Needs **r152 or newer**: earlier versions have different chunk
names and a different color management model.

It does **not** work with `WebGPURenderer` / TSL — that path does not go through
`onBeforeCompile` at all.

## Zones, if you do want them

The chroma key exists because in this project the heat has to appear *under* the suit
armor. Green in the texture marks where the heat may show; everything else draws on top.

If you want the same:

```js
heat.set('zoneOn', true);
heat.set('zoneUseBase', false);          // key against a separate map, not the base texture
heat.setZoneTexture(myZoneTexture);      // THREE.Texture, sRGB, flipY matching your UVs
heat.set('zoneKey', '#00ff00');
heat.set('zoneTol', 0.5);
heat.set('zoneSoft', 0.28);
```

Turn on `heat.set('zoneDebug', true)` to render the raw mask in black and white over the
model. That is by far the fastest way to check the mask lines up with your UVs.

## The grid, if you want it

```js
heat.set('gridOn', true);
heat.set('gridMode', 'triplanar');   // or 'uv'
heat.set('gridSource', 'pattern');   // needs setGridTexture, otherwise use 'lines'
heat.setGridTexture(tex);            // tileable, RepeatWrapping, alpha = coverage
```

**If you use `triplanar` you must set the world scale**, otherwise density means
"cells per model unit" and will look wrong at any scale but 1:

```js
heat.uniforms.uGridWorldScale.value = 1 / modelHeightInUnits;
```

With that set, `gridDensity` means "repeats across the model's height" in both
projections.

## Two color modes

This trips people up because it is not a cosmetic switch:

- `heat.set('colorMode', 'accumulated')` — classic heatmap. The color comes from how
  much heat piled up. Overlapping points push toward the hot end; a low weight is both
  faint **and** cold.
- `heat.set('colorMode', 'perPoint')` — each point carries its own `level` (0..1) and
  that is its color. Coverage still decides where and how strongly it paints, but the
  color is independent. This is what you want if "no pain" has to read as a solid green
  rather than as nothing.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Nothing shows at all | Material is not Standard/Physical, or `attach()` ran on a material the mesh does not actually use |
| Random blotches unrelated to your points | `zoneOn` left on, keying against your texture |
| Everything washed out / gray | `desat` left at 0.8 |
| Points land in the wrong place | Coordinates in world space instead of raw local space, or an untransformed model |
| Heat is a tiny dot, or covers everything | `radius` not in model units |
| Grid far too dense or too sparse | `uGridWorldScale` not set with triplanar |
| Works on one mesh, not others | `attach()` must be called on every material |
| Heat invisible on metal parts | Expected on metals; the layer already lowers `metalnessFactor` by the heat, but if you patched a material yourself you lose that |
| Colors look off vs the demo | Renderer settings, not the layer: this project uses `ACESFilmicToneMapping` and an environment map |

## API

```js
const heat = new HeatmapLayer({ presetId: 'classic' });

heat.attach(material);            // patch a material (call once per material)

heat.addPoint({ x, y, z, radius, weight, level, sx, sy, sz });
heat.removePoint(id);
heat.duplicatePoint(id, offsetX);
heat.getPoint(id);
heat.clearPoints();
heat.sync();                      // after mutating point objects directly

heat.set(key, value);             // any key in heat.settings
heat.setStops([{ pos, color }]);  // custom gradient
heat.applyPreset('turbo');
heat.setZoneTexture(tex);         // or null
heat.setGridTexture(tex);         // or null

heat.colorAt(t);                  // CSS color from the ramp, for your own UI
heat.painLevel(point);            // 0..1, respects the current color mode

heat.toJSON();                    // full state
heat.fromJSON(obj);
heat.dispose();
```

Per point fields: `x, y, z` position, `radius`, `weight` (coverage), `level` (pain, 0..1),
`sx, sy, sz` (per axis radius factors — 1/1/1 is a sphere, anything else an ellipsoid),
`nx, ny, nz` (surface normal, only used by this project's marker overlay — you can leave
them at their defaults).

`heat.settings` holds every tunable; read it once in a console to see the full list with
current values.

## What is intentionally not in the layer

- The marker overlay (`<div>` rings) — that lives in `src/viewer.js` under
  `refreshMarkers` / `updateMarkers`, about 60 lines, easy to lift if you want it.
- Point picking by click — also `src/viewer.js`, `_handleClick`.
- Anything to do with the editor panel.
- Lighting. The layer writes to `diffuseColor`, so it inherits whatever lighting your
  scene already has.

## Caveat

The layer caps at **64 points** (`MAX_POINTS` in `heatmap.js`). Raising it means bigger
uniform arrays; past a few hundred you would want a data texture instead of uniforms,
which is a different implementation.
