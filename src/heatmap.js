import * as THREE from 'three';
import { GradientTexture, PRESETS, normalizePresetId } from './gradient.js';

/** Max simultaneous points, capped by the shader uniform arrays. */
export const MAX_POINTS = 64;

export const BLEND_MODES = [
  { id: 0, label: 'Under the texture', hint: 'The heatmap sets the hue while the texture keeps its detail and shading.' },
  { id: 1, label: 'Multiply', hint: 'Darkens. The texture stays fully visible, tinted by the heatmap.' },
  { id: 2, label: 'Over (normal)', hint: 'Covers the texture with the flat heatmap color.' },
  { id: 3, label: 'Screen', hint: 'Lightens. Good for dark palettes over light textures.' },
  { id: 4, label: 'Overlay', hint: 'Keeps highlights and shadows, raises contrast a lot.' },
  { id: 5, label: 'Additive', hint: 'Adds light. Gives a glowing or emissive look.' },
];

const FRAG_HEAD = /* glsl */ `
uniform vec4  uHeatPoints[${MAX_POINTS}]; // xyz = center in model space, w = radius
uniform vec3  uHeatScale[${MAX_POINTS}];  // per axis radius factor: allows ellipsoids
uniform float uHeatWeights[${MAX_POINTS}];
uniform float uHeatLevels[${MAX_POINTS}]; // how much each point hurts, 0..1
uniform int   uHeatColorMode;             // 0 = accumulated heat, 1 = per point level
uniform int   uHeatCount;
uniform sampler2D uHeatGradient;
uniform float uHeatIntensity;
uniform float uHeatOpacity;
uniform float uHeatFalloff;
uniform float uHeatFloor;
uniform float uHeatDesat;
uniform int   uHeatBlend;
varying vec3  vHeatLocal;

// --- zone map (chroma key) ---
uniform sampler2D uZoneMap;
uniform int   uZoneOn;
uniform int   uZoneUseBase; // 1 = key against the model's own texture
uniform vec3  uZoneKey;     // key color, already in linear space
uniform vec3  uZoneFlat;    // flat color for the heat zone
uniform vec3  uZoneArmor;   // armor tint (white leaves it untouched)
uniform float uZoneTol;
uniform float uZoneSoft;
uniform int   uZoneInvert;
uniform int   uZoneDebug;
varying vec2  vHeatUv;

// --- procedural grid ---
uniform int   uGridOn;
uniform int   uGridMode;       // 0 = UV, 1 = triplanar in model space
uniform float uGridDensity;
uniform float uGridWidth;
uniform float uGridWorldScale; // makes "density" mean the same thing in both modes
uniform vec3  uGridColor;
uniform float uGridOpacity;
uniform int   uGridZoneOnly;
uniform float uGridRotation;   // radians
uniform float uGridAspect;     // >1 stretches the cell vertically
uniform int   uGridStyle;      // 0 square, 1 horizontal only, 2 vertical only
uniform sampler2D uGridMap;   // tileable pattern, alpha = line coverage
uniform int   uGridUseMap;    // 1 = sample the pattern instead of drawing lines
varying vec3  vHeatNormal;

/** Applies aspect and rotation, shared by both grid sources. */
vec2 heatGridUv(vec2 q) {
  q *= vec2(1.0, uGridAspect);
  float c = cos(uGridRotation);
  float s = sin(uGridRotation);
  return mat2(c, -s, s, c) * q;
}

/** Cell lines over a 2D plane, with the width measured in screen space. */
float heatGridLines(vec2 q, float width) {
  q = heatGridUv(q);
  vec2 cell = abs(fract(q) - 0.5);
  float d = uGridStyle == 1 ? cell.y
          : uGridStyle == 2 ? cell.x
          : min(cell.x, cell.y);   // 0 on a line, 0.5 at the cell center
  float aa = fwidth(d);            // how much d changes from one pixel to the next
  return 1.0 - smoothstep(width, width + aa + 0.004, d);
}

/**
 * Coverage taken from the tileable pattern. The alpha channel carries the weave,
 * so only that is read; the color stays under the panel's control.
 */
float heatGridPattern(vec2 q) {
  return texture2D(uGridMap, heatGridUv(q)).a;
}

/** Either source, so the triplanar blend does not care which one is active. */
float heatGridAt(vec2 q, float width) {
  return uGridUseMap == 1 ? heatGridPattern(q) : heatGridLines(q, width);
}

#define HEAT_LUMA(c) dot((c), vec3(0.2126, 0.7152, 0.0722))

vec3 heatSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

/**
 * How close a color is to the key color, ignoring brightness: 1.0 on an exact
 * match and 0.0 on any gray. Normalizing against the key's chroma makes the
 * tolerance mean the same thing whatever key color is chosen.
 */
float zoneKeyMatch(vec3 c, vec3 k) {
  vec3 kc = k - vec3((k.r + k.g + k.b) / 3.0);
  float kk = dot(kc, kc);
  if (kk < 1e-6) return 0.0;
  vec3 cc = c - vec3((c.r + c.g + c.b) / 3.0);
  return dot(cc, kc) / kk;
}

/**
 * Returns (coverage, weighted level).
 *
 * Splitting the two is what lets a point that does not hurt show up green and
 * solid instead of nearly transparent: coverage decides WHERE and HOW MUCH gets
 * painted, the level decides WHAT COLOR.
 */
vec2 heatField(vec3 p) {
  float acc = 0.0;
  float levelSum = 0.0;
  for (int i = 0; i < ${MAX_POINTS}; i++) {
    if (i >= uHeatCount) break;
    vec4 hp = uHeatPoints[i];
    // dividing per axis turns the sphere into an ellipsoid without changing the formula
    vec3 radii = max(hp.w * uHeatScale[i], vec3(1e-5));
    float t = 1.0 - clamp(length((p - hp.xyz) / radii), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);              // smoothstep: seamless edges
    float contribution = pow(t, uHeatFalloff) * uHeatWeights[i];
    acc += contribution;
    levelSum += contribution * uHeatLevels[i];
  }
  return vec2(acc, levelSum);
}
`;

const FRAG_BODY = /* glsl */ `
{
  // The zone map decides where heat may appear. On green (or whatever key color
  // is chosen) the heatmap wins; outside green the map itself wins, and that is
  // what draws the armor and the seams on top.
  float zone = 1.0;
  if (uZoneOn == 1) {
    // When the model's texture already is the zone map, key straight against it:
    // no second image needed and the UVs match by construction.
    vec3 zoneColor = uZoneUseBase == 1
      ? diffuseColor.rgb
      : texture2D(uZoneMap, vHeatUv).rgb;
    float match = zoneKeyMatch(zoneColor, uZoneKey);
    zone = smoothstep(uZoneTol - uZoneSoft, uZoneTol + uZoneSoft, match);
    if (uZoneInvert == 1) zone = 1.0 - zone;

    // Despill: inside the transition band the map still carries some of the key
    // color. It is neutralized in proportion to the match, so green never reaches
    // the render as a halo along the armor edges.
    vec3 armor = mix(zoneColor, vec3(HEAT_LUMA(zoneColor)), clamp(match, 0.0, 1.0));

    // Tint by multiplication: white changes nothing and any other color keeps the
    // shading and panel lines instead of flattening them.
    armor *= uZoneArmor;

    // With zones on, the original texture is discarded ENTIRELY: it was the source
    // of the rainbow background and the fabric grid. The only thing drawn is this
    // map, and the heat zone becomes a flat color.
    diffuseColor.rgb = mix(armor, uZoneFlat, zone);
  }

  if (uZoneDebug == 1) {
    diffuseColor.rgb = vec3(zone);
  } else {

  // Lower the texture saturation so the heat reads on models with very colorful
  // textures.
  if (uHeatDesat > 0.0) {
    float baseLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(baseLuma), uHeatDesat);
  }

  vec2 field = heatField(vHeatLocal);
  float heat = clamp(field.x * uHeatIntensity, 0.0, 1.0);
  float mask = max(heat, uHeatFloor) * uHeatOpacity * zone;
  heatMask = mask;

  // In "per point" mode the color comes from the weighted average of the nearby
  // pain levels rather than from how much heat piled up. That way a point at 0
  // paints green with the same presence as a point at 1 paints red.
  float colorT = uHeatColorMode == 1
    ? clamp(field.y / max(field.x, 1e-5), 0.0, 1.0)
    : heat;

  if (mask > 0.0005) {
    vec3 base = diffuseColor.rgb;
    vec3 heatColor = heatSrgbToLinear(
      texture2D(uHeatGradient, vec2(clamp(colorT, 0.002, 0.998), 0.5)).rgb
    );
    vec3 blended;

    if (uHeatBlend == 0) {
      // "under the texture": the heatmap supplies the color, the texture the detail.
      // The factor stays near 1.0 so the color does not wash out on light models.
      float luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
      blended = heatColor * (0.55 + 0.75 * luma);
    } else if (uHeatBlend == 1) {
      blended = base * heatColor;
    } else if (uHeatBlend == 2) {
      blended = heatColor;
    } else if (uHeatBlend == 3) {
      blended = 1.0 - (1.0 - base) * (1.0 - heatColor);
    } else if (uHeatBlend == 4) {
      blended = mix(
        2.0 * base * heatColor,
        1.0 - 2.0 * (1.0 - base) * (1.0 - heatColor),
        step(0.5, base)
      );
    } else {
      blended = base + heatColor;
    }

    diffuseColor.rgb = mix(base, blended, clamp(mask, 0.0, 1.0));
  }

  // The grid goes on top of everything, and is drawn mathematically instead of
  // from a texture: a 1px line in a map disappears under minification, this one
  // stays crisp at any distance.
  if (uGridOn == 1) {
    float line;

    if (uGridMode == 1) {
      // Triplanar: the cell is defined in model space and projected from the three
      // axes, weighted by the normal. Same cell size and orientation across the
      // whole model, independent of the unwrap -- which on AI generated models is a
      // pile of loose islands, each rotated and at its own density.
      vec3 p = vHeatLocal * uGridDensity * uGridWorldScale;
      vec3 w = pow(abs(normalize(vHeatNormal)), vec3(6.0));
      w /= max(w.x + w.y + w.z, 1e-5);
      line = heatGridAt(p.yz, uGridWidth) * w.x
           + heatGridAt(p.xz, uGridWidth) * w.y
           + heatGridAt(p.xy, uGridWidth) * w.z;
    } else {
      line = heatGridAt(vHeatUv * uGridDensity, uGridWidth);
    }

    float amount = line * uGridOpacity * (uGridZoneOnly == 1 ? zone : 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, uGridColor, clamp(amount, 0.0, 1.0));
  }

  } // end of uZoneDebug == 0
}
`;

let nextPointId = 1;

/** Old Spanish color mode ids, so configs exported before the rename still load. */
const LEGACY_COLOR_MODES = { acumulado: 'accumulated', porPunto: 'perPoint' };

/**
 * Dynamic heatmap layer injected into any standard/physical material of the
 * model via onBeforeCompile. The heat field is evaluated in model space, so it
 * does not depend on the UV mapping (which on generated models tends to be
 * fragmented) and follows the mesh when it rotates.
 */
export class HeatmapLayer {
  constructor({ presetId = 'classic' } = {}) {
    this.points = [];
    this.presetId = normalizePresetId(presetId);
    this.stops = PRESETS[this.presetId].stops.map((s) => ({ ...s }));
    this.gradient = new GradientTexture(this.stops);

    this.settings = {
      intensity: 1.0,
      opacity: 0.9,
      falloff: 1.0,
      sizeScale: 1.0,
      // 'accumulated': the color comes from how much heat piled up (classic heatmap).
      // 'perPoint': each point carries its own pain level and that is its color.
      colorMode: 'accumulated',
      floor: 0.0,
      desat: 0.8, // this model's texture is multicolored: without this the heat is unreadable
      blend: 0,
      // zone map
      zoneOn: true,
      zoneUseBase: true, // the model texture already is the green map
      zoneKey: '#04c504',
      zoneFlat: '#d9dde4',
      zoneArmor: '#ffffff',
      zoneTol: 0.5,
      zoneSoft: 0.28,
      zoneInvert: false,
      zoneDebug: false,
      // procedural grid
      gridOn: true,
      // 'triplanar' by default: this model's UVs are auto generated islands, and a
      // grid in UV space comes out rotated and at a different size on every part
      gridMode: 'triplanar',
      gridDensity: 60,
      gridWidth: 0.035,
      gridColor: '#ffffff',
      gridOpacity: 0.22,
      gridZoneOnly: true,
      gridRotation: 0,
      gridAspect: 1,
      gridStyle: 0,
      // 'pattern' samples a tileable image, 'lines' draws them mathematically
      gridSource: 'lines',
      // Markers: a screen space UI overlay. The structure is dot, gap and outer
      // ring; both share one color.
      markOn: true,
      markSize: 34, // outer ring diameter
      markDot: 14, // center dot diameter
      markBorder: 3, // ring thickness
      markColor: '#ffffff',
      markUsePain: false, // true: dot and ring take the pain level color
      markOpacity: 1,
      markHideBehind: true,
    };

    // 1x1 white: the sampler always needs something bound
    this._emptyZone = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      THREE.RGBAFormat
    );
    this._emptyZone.needsUpdate = true;
    this.zoneTexture = null;
    this.gridTexture = null;

    this.uniforms = {
      uHeatPoints: { value: new Float32Array(MAX_POINTS * 4) },
      uHeatScale: { value: new Float32Array(MAX_POINTS * 3).fill(1) },
      uHeatWeights: { value: new Float32Array(MAX_POINTS) },
      uHeatLevels: { value: new Float32Array(MAX_POINTS).fill(1) },
      uHeatColorMode: { value: 0 },
      uHeatCount: { value: 0 },
      uHeatGradient: { value: this.gradient.texture },
      uHeatIntensity: { value: this.settings.intensity },
      uHeatOpacity: { value: this.settings.opacity },
      uHeatFalloff: { value: this.settings.falloff },
      uHeatFloor: { value: this.settings.floor },
      uHeatDesat: { value: this.settings.desat },
      uHeatBlend: { value: this.settings.blend },
      uZoneMap: { value: this._emptyZone },
      uZoneOn: { value: this.settings.zoneOn ? 1 : 0 },
      uZoneUseBase: { value: this.settings.zoneUseBase ? 1 : 0 },
      uZoneKey: { value: new THREE.Color().setStyle(this.settings.zoneKey, THREE.SRGBColorSpace) },
      uZoneFlat: { value: new THREE.Color().setStyle(this.settings.zoneFlat, THREE.SRGBColorSpace) },
      uZoneArmor: { value: new THREE.Color().setStyle(this.settings.zoneArmor, THREE.SRGBColorSpace) },
      uZoneTol: { value: this.settings.zoneTol },
      uZoneSoft: { value: this.settings.zoneSoft },
      uZoneInvert: { value: 0 },
      uZoneDebug: { value: 0 },
      uGridOn: { value: this.settings.gridOn ? 1 : 0 },
      uGridMode: { value: this.settings.gridMode === 'triplanar' ? 1 : 0 },
      uGridWorldScale: { value: 1 },
      uGridDensity: { value: this.settings.gridDensity },
      uGridWidth: { value: this.settings.gridWidth },
      uGridColor: { value: new THREE.Color().setStyle(this.settings.gridColor, THREE.SRGBColorSpace) },
      uGridOpacity: { value: this.settings.gridOpacity },
      uGridZoneOnly: { value: this.settings.gridZoneOnly ? 1 : 0 },
      uGridRotation: { value: 0 },
      uGridAspect: { value: this.settings.gridAspect },
      uGridStyle: { value: this.settings.gridStyle },
      uGridMap: { value: this._emptyZone },
      uGridUseMap: { value: 0 },
    };

    this.onChange = null;
    this._materials = new Set();
  }

  /** Patches a material so it draws the heat layer. */
  attach(material) {
    if (this._materials.has(material)) return;
    this._materials.add(material);

    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      // vHeatUv is declared separately instead of reusing three's vMapUv/vUv,
      // because those only exist depending on which textures the material has.
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vHeatLocal;\nvarying vec2 vHeatUv;\nvarying vec3 vHeatNormal;'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvHeatLocal = position;\nvHeatUv = uv;\nvHeatNormal = normal;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
        .replace(
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          'vec4 diffuseColor = vec4( diffuse, opacity );\nfloat heatMask = 0.0;'
        )
        .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_BODY}`)
        // A metal has no diffuse lobe, so writing to diffuseColor is invisible
        // where metalness is high. It is lowered in proportion to the heat so the
        // heatmap stays visible over metallic parts.
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - heatMask;'
        );
    };
    // keeps three from reusing an unpatched program from an otherwise identical material
    material.customProgramCacheKey = () => 'heatmap-layer-v1';
    material.needsUpdate = true;
  }

  // ---- points -------------------------------------------------------------

  addPoint({ x, y, z, radius, weight = 1, level = 1, sx = 1, sy = 1, sz = 1, nx = 0, ny = 0, nz = 1 }) {
    if (this.points.length >= MAX_POINTS) return null;
    const point = {
      id: nextPointId++,
      x,
      y,
      z,
      radius,
      weight, // how much it paints
      level, // how much it hurts: 0 = not at all (green), 1 = a lot (red)
      sx, // per axis radius factors: 1,1,1 is a sphere
      sy,
      sz,
      nx, // surface normal where it sits, used to hide the marker when facing away
      ny,
      nz,
    };
    this.points.push(point);
    this.sync();
    return point;
  }

  /** Copies a point with all of its settings, offset so it does not sit on top. */
  duplicatePoint(id, offset = 0) {
    const source = this.getPoint(id);
    if (!source || this.points.length >= MAX_POINTS) return null;
    const { id: _ignored, ...rest } = source;
    return this.addPoint({ ...rest, x: source.x + offset });
  }

  removePoint(id) {
    const i = this.points.findIndex((p) => p.id === id);
    if (i === -1) return false;
    this.points.splice(i, 1);
    this.sync();
    return true;
  }

  getPoint(id) {
    return this.points.find((p) => p.id === id) || null;
  }

  clearPoints() {
    this.points.length = 0;
    this.sync();
  }

  /** Final radius of a point: its own times the global scale. */
  effectiveRadius(point) {
    return Math.max(point.radius * this.settings.sizeScale, 1e-4);
  }

  // ---- state --------------------------------------------------------------

  set(key, value) {
    if (key === 'colorMode') value = LEGACY_COLOR_MODES[value] || value;
    this.settings[key] = value;

    const map = {
      intensity: 'uHeatIntensity',
      opacity: 'uHeatOpacity',
      falloff: 'uHeatFalloff',
      floor: 'uHeatFloor',
      desat: 'uHeatDesat',
      blend: 'uHeatBlend',
      zoneTol: 'uZoneTol',
      zoneSoft: 'uZoneSoft',
      gridDensity: 'uGridDensity',
      gridWidth: 'uGridWidth',
      gridOpacity: 'uGridOpacity',
      gridAspect: 'uGridAspect',
      gridStyle: 'uGridStyle',
    };
    if (map[key]) this.uniforms[map[key]].value = value;

    if (key === 'colorMode') {
      this.uniforms.uHeatColorMode.value = value === 'perPoint' ? 1 : 0;
    }
    if (key === 'gridOn') this.uniforms.uGridOn.value = value ? 1 : 0;
    if (key === 'gridSource') this._refreshGridSource();
    if (key === 'gridMode') this.uniforms.uGridMode.value = value === 'triplanar' ? 1 : 0;
    if (key === 'gridZoneOnly') this.uniforms.uGridZoneOnly.value = value ? 1 : 0;
    if (key === 'gridColor') {
      this.uniforms.uGridColor.value.setStyle(value, THREE.SRGBColorSpace);
    }
    if (key === 'gridRotation') {
      this.uniforms.uGridRotation.value = (value * Math.PI) / 180;
    }

    if (key === 'zoneOn' || key === 'zoneUseBase') this._refreshZoneState();
    if (key === 'zoneInvert') this.uniforms.uZoneInvert.value = value ? 1 : 0;
    if (key === 'zoneDebug') this.uniforms.uZoneDebug.value = value ? 1 : 0;
    if (key === 'zoneKey') {
      this.uniforms.uZoneKey.value.setStyle(value, THREE.SRGBColorSpace);
    }
    if (key === 'zoneFlat') {
      this.uniforms.uZoneFlat.value.setStyle(value, THREE.SRGBColorSpace);
    }
    if (key === 'zoneArmor') {
      this.uniforms.uZoneArmor.value.setStyle(value, THREE.SRGBColorSpace);
    }
    if (key === 'sizeScale') this.sync();
    this.onChange?.();
  }

  _refreshGridSource() {
    const usable = this.settings.gridSource === 'pattern' && !!this.gridTexture;
    this.uniforms.uGridUseMap.value = usable ? 1 : 0;
  }

  /**
   * Binds the tileable grid pattern. Only its alpha is read, so the panel keeps
   * control of the color; passing null falls back to the procedural lines.
   */
  setGridTexture(texture) {
    if (this.gridTexture && this.gridTexture !== texture) this.gridTexture.dispose();
    this.gridTexture = texture || null;
    this.uniforms.uGridMap.value = texture || this._emptyZone;
    this._refreshGridSource();
    this.onChange?.();
  }

  /** The chroma key can only run if there is a map to read from. */
  hasZoneSource() {
    return this.settings.zoneUseBase || !!this.zoneTexture;
  }

  _refreshZoneState() {
    this.uniforms.uZoneUseBase.value = this.settings.zoneUseBase ? 1 : 0;
    this.uniforms.uZoneOn.value = this.settings.zoneOn && this.hasZoneSource() ? 1 : 0;
  }

  /**
   * Binds an external zone map. Green (or the chosen key color) marks where the
   * heatmap shows; the rest is drawn as is, on top. Passing null goes back to
   * using the model's own texture.
   */
  setZoneTexture(texture) {
    if (this.zoneTexture && this.zoneTexture !== texture) this.zoneTexture.dispose();
    this.zoneTexture = texture || null;
    this.uniforms.uZoneMap.value = texture || this._emptyZone;
    this.settings.zoneUseBase = !texture;
    this._refreshZoneState();
    this.onChange?.();
  }

  setStops(stops) {
    this.stops = stops.map((s) => ({ ...s }));
    this.gradient.update(this.stops);
    this.onChange?.();
  }

  applyPreset(presetId) {
    const id = normalizePresetId(presetId);
    if (!PRESETS[id]) return;
    this.presetId = id;
    this.setStops(PRESETS[id].stops);
  }

  /** Flushes the points into the uniforms. */
  sync() {
    const pts = this.uniforms.uHeatPoints.value;
    const scl = this.uniforms.uHeatScale.value;
    const wts = this.uniforms.uHeatWeights.value;
    const lvl = this.uniforms.uHeatLevels.value;
    const n = Math.min(this.points.length, MAX_POINTS);

    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const o = i * 4;
      pts[o] = p.x;
      pts[o + 1] = p.y;
      pts[o + 2] = p.z;
      pts[o + 3] = this.effectiveRadius(p);
      const s = i * 3;
      scl[s] = Math.max(p.sx ?? 1, 1e-3);
      scl[s + 1] = Math.max(p.sy ?? 1, 1e-3);
      scl[s + 2] = Math.max(p.sz ?? 1, 1e-3);
      wts[i] = p.weight;
      lvl[i] = p.level ?? 1;
    }
    this.uniforms.uHeatCount.value = n;
  }

  /** Gradient color at t (0..1) as CSS. Used by the marker overlay. */
  colorAt(t) {
    const data = this.gradient.data;
    const n = data.length / 4;
    const i = Math.round(Math.max(0, Math.min(1, t)) * (n - 1)) * 4;
    return `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`;
  }

  /** Pain level of a point, 0..1: this is what colors the marker. */
  painLevel(point) {
    const raw =
      this.settings.colorMode === 'perPoint'
        ? (point.level ?? 1)
        : point.weight * this.settings.intensity;
    return Math.max(0, Math.min(1, raw));
  }

  // ---- serialization ------------------------------------------------------

  toJSON() {
    return {
      version: 1,
      settings: { ...this.settings },
      presetId: this.presetId,
      stops: this.stops.map((s) => ({ ...s })),
      points: this.points.map(({ id, ...rest }) => rest),
    };
  }

  fromJSON(data) {
    if (!data || typeof data !== 'object') throw new Error('Invalid config');

    if (data.settings) {
      for (const [k, v] of Object.entries(data.settings)) {
        if (k in this.settings) this.set(k, v);
      }
    }
    if (Array.isArray(data.stops) && data.stops.length >= 2) {
      const id = normalizePresetId(data.presetId);
      this.presetId = id && PRESETS[id] ? id : 'custom';
      this.setStops(data.stops);
    }
    if (Array.isArray(data.points)) {
      this.points = data.points.slice(0, MAX_POINTS).map((p) => {
        const x = +p.x || 0;
        const y = +p.y || 0;
        const z = +p.z || 0;
        // with no stored normal, approximate with the radial direction from the
        // center: on a humanoid body that is enough to tell if the point faces front
        const len = Math.hypot(x, y, z) || 1;
        return {
          id: nextPointId++,
          x,
          y,
          z,
          radius: +p.radius || 0.2,
          weight: p.weight === undefined ? 1 : +p.weight,
          level: p.level === undefined ? 1 : +p.level,
          sx: p.sx === undefined ? 1 : +p.sx,
          sy: p.sy === undefined ? 1 : +p.sy,
          sz: p.sz === undefined ? 1 : +p.sz,
          nx: p.nx === undefined ? x / len : +p.nx,
          ny: p.ny === undefined ? y / len : +p.ny,
          nz: p.nz === undefined ? z / len : +p.nz,
        };
      });
    }
    this.sync();
    this.onChange?.();
  }

  dispose() {
    this.gradient.dispose();
    this._materials.clear();
  }
}
