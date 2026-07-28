import { HeatmapLayer } from './heatmap.js';
import { Viewer } from './viewer.js';
import { EditorUI } from './ui.js';
// Startup config. To change it: tune everything in the panel, hit "Export JSON"
// and paste the file over this one.
import defaultConfig from './default-config.json';

const MODEL_URL = 'models/astronaut.glb';
const GRID_PATTERN_URL = 'textures/mesh-pattern.png';
const ENVIRONMENT_URL = 'env/nebulae.hdr';

const canvas = document.getElementById('view');
const loader = document.getElementById('loader');
const fill = document.getElementById('loader-fill');
const pct = document.getElementById('loader-pct');

const heatmap = new HeatmapLayer({ presetId: 'classic' });
const viewer = new Viewer(canvas, heatmap);

function progress(ratio, loaded) {
  if (ratio != null) {
    fill.style.width = `${(ratio * 100).toFixed(0)}%`;
    pct.textContent = `${(ratio * 100).toFixed(0)}%`;
  } else if (loaded) {
    pct.textContent = `${(loaded / 1e6).toFixed(1)} MB`;
  }
}

async function boot() {
  const info = await viewer.load(MODEL_URL, progress);

  const ui = new EditorUI(heatmap, viewer);

  // The tileable weave, if it ships with the project. It is bound before the
  // config so a config asking for gridSource: 'pattern' finds it already there.
  try {
    heatmap.setGridTexture(await viewer.loadGridTexture(GRID_PATTERN_URL));
  } catch {
    /* no pattern shipped: the grid falls back to the procedural lines */
  }

  // The HDRI environment, if one ships with the project. Loaded before the config
  // so a config asking for environment: 'hdri' finds it already prefiltered.
  try {
    await viewer.loadEnvironment(ENVIRONMENT_URL);
  } catch {
    /* no HDRI shipped: the synthetic studio environment stays */
  }

  try {
    ui.applyConfig(defaultConfig);
  } catch (err) {
    console.warn('default-config.json is invalid, scattering random points:', err);
    ui.seedRandom(5);
  }


  document.getElementById('hud-stats').textContent =
    `${info.triangles.toLocaleString('en-US')} triangles · ` +
    `${info.size.x.toFixed(2)} × ${info.size.y.toFixed(2)} × ${info.size.z.toFixed(2)} u`;

  loader.classList.add('done');
  viewer.start();

  /**
   * Public API for feeding the heatmap from real data.
   * e.g.  heatmap.setPoints([{ x: 0, y: .4, z: .2, radius: .3, weight: 1 }])
   */
  window.heatmap = {
    layer: heatmap,
    viewer,
    ui,

    setPoints(points) {
      heatmap.clearPoints();
      for (const p of points) {
        heatmap.addPoint({
          x: +p.x || 0,
          y: +p.y || 0,
          z: +p.z || 0,
          radius: p.radius ?? ui.defaultRadius,
          weight: p.weight ?? 1,
        });
      }
      ui.refreshAll();
    },
    addPoint(p) {
      const created = heatmap.addPoint({
        x: +p.x || 0,
        y: +p.y || 0,
        z: +p.z || 0,
        radius: p.radius ?? ui.defaultRadius,
        weight: p.weight ?? 1,
      });
      ui.refreshAll();
      return created;
    },
    clear() {
      heatmap.clearPoints();
      viewer.select(null);
      ui.refreshAll();
    },
    /** set('intensity'|'opacity'|'falloff'|'sizeScale'|'floor'|'blend'|'markSize'|..., value) */
    set(key, value) {
      heatmap.set(key, value);
      ui.refreshAll();
    },
    setGradient(stops) {
      heatmap.setStops(stops);
      heatmap.presetId = 'custom';
      ui.refreshAll();
    },
    applyPreset(id) {
      heatmap.applyPreset(id);
      ui.refreshAll();
    },
    /** Loads a zone map from a URL (or a blob:). */
    loadZoneMap: (url, label = 'mapa') => ui.loadZone(url, label),
    /** setLight('keyIntensity'|'azimuth'|'elevation'|'shadows'|..., value) */
    setLight(key, value) {
      viewer.setLight(key, value);
      ui.refreshAll();
    },
    getConfig: () => ui.getConfig(),
    loadConfig: (cfg) => ui.applyConfig(cfg),
  };
}

boot().catch((err) => {
  console.error(err);
  document.querySelector('.loader-title').textContent = 'Error loading the model';
  pct.textContent = err.message;
});
