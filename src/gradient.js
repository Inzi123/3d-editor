import * as THREE from 'three';

export const GRADIENT_RESOLUTION = 256;

/**
 * Starter palettes. Each stop is { pos: 0..1, color: '#rrggbb' }.
 *
 * The first stop is usually the "zero" of the heatmap, so a cold or dark color
 * works best there: it is what shows up in the low intensity areas.
 */
export const PRESETS = {
  classic: {
    label: 'Classic',
    stops: [
      { pos: 0.0, color: '#1b2ea8' },
      { pos: 0.28, color: '#12b6d4' },
      { pos: 0.52, color: '#3ad63a' },
      { pos: 0.76, color: '#f7e03d' },
      { pos: 1.0, color: '#e01b1b' },
    ],
  },
  inferno: {
    label: 'Inferno',
    stops: [
      { pos: 0.0, color: '#000004' },
      { pos: 0.25, color: '#420a68' },
      { pos: 0.5, color: '#932667' },
      { pos: 0.75, color: '#dd513a' },
      { pos: 0.9, color: '#fca50a' },
      { pos: 1.0, color: '#fcffa4' },
    ],
  },
  viridis: {
    label: 'Viridis',
    stops: [
      { pos: 0.0, color: '#440154' },
      { pos: 0.25, color: '#3b528b' },
      { pos: 0.5, color: '#21918c' },
      { pos: 0.75, color: '#5ec962' },
      { pos: 1.0, color: '#fde725' },
    ],
  },
  turbo: {
    label: 'Turbo',
    stops: [
      { pos: 0.0, color: '#30123b' },
      { pos: 0.2, color: '#4267f7' },
      { pos: 0.4, color: '#1ae4b6' },
      { pos: 0.6, color: '#a4fc3c' },
      { pos: 0.8, color: '#fb8022' },
      { pos: 1.0, color: '#7a0403' },
    ],
  },
  fire: {
    label: 'Fire',
    stops: [
      { pos: 0.0, color: '#2b0000' },
      { pos: 0.35, color: '#b32100' },
      { pos: 0.7, color: '#ff9d00' },
      { pos: 1.0, color: '#fff6d0' },
    ],
  },
  cool: {
    label: 'Cool',
    stops: [
      { pos: 0.0, color: '#04173d' },
      { pos: 0.45, color: '#1268c3' },
      { pos: 0.8, color: '#40dcf0' },
      { pos: 1.0, color: '#ffffff' },
    ],
  },
  traffic: {
    label: 'Traffic light',
    stops: [
      { pos: 0.0, color: '#0a7d2c' },
      { pos: 0.5, color: '#f2c414' },
      { pos: 1.0, color: '#d61f1f' },
    ],
  },
  neon: {
    label: 'Neon',
    stops: [
      { pos: 0.0, color: '#12043a' },
      { pos: 0.4, color: '#7b2ff7' },
      { pos: 0.72, color: '#f52ea6' },
      { pos: 1.0, color: '#00fff0' },
    ],
  },
};

/** Old Spanish preset ids, so configs exported before the rename still load. */
const LEGACY_PRESET_IDS = {
  clasico: 'classic',
  fuego: 'fire',
  frio: 'cool',
  semaforo: 'traffic',
};

export function normalizePresetId(id) {
  return LEGACY_PRESET_IDS[id] || id;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const to = (x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** CSS ready to paint the editor preview bar. */
export function stopsToCss(stops) {
  const sorted = sortStops(stops);
  const parts = sorted.map((s) => `${s.color} ${(s.pos * 100).toFixed(2)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

export function sortStops(stops) {
  return [...stops].sort((a, b) => a.pos - b.pos);
}

/**
 * 256x1 color ramp the shader samples with the heatmap intensity.
 *
 * It is kept in raw sRGB (NoColorSpace) and converted to linear inside the
 * fragment shader, so the result does not depend on how three uploads it.
 */
export class GradientTexture {
  constructor(stops) {
    this.data = new Uint8Array(GRADIENT_RESOLUTION * 4);
    this.texture = new THREE.DataTexture(
      this.data,
      GRADIENT_RESOLUTION,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.update(stops);
  }

  update(stops) {
    const sorted = sortStops(stops);
    if (sorted.length === 0) return;

    const rgb = sorted.map((s) => hexToRgb(s.color));
    const data = this.data;

    for (let i = 0; i < GRADIENT_RESOLUTION; i++) {
      const t = i / (GRADIENT_RESOLUTION - 1);

      let hi = 0;
      while (hi < sorted.length && sorted[hi].pos < t) hi++;

      let r, g, b;
      if (hi === 0) {
        [r, g, b] = rgb[0];
      } else if (hi >= sorted.length) {
        [r, g, b] = rgb[rgb.length - 1];
      } else {
        const a = sorted[hi - 1];
        const c = sorted[hi];
        const span = c.pos - a.pos;
        const k = span <= 1e-6 ? 0 : (t - a.pos) / span;
        const ca = rgb[hi - 1];
        const cc = rgb[hi];
        r = ca[0] + (cc[0] - ca[0]) * k;
        g = ca[1] + (cc[1] - ca[1]) * k;
        b = ca[2] + (cc[2] - ca[2]) * k;
      }

      const o = i * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }

    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
