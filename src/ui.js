import { BLEND_MODES, MAX_POINTS } from './heatmap.js';
import { PRESETS, sortStops, stopsToCss, rgbToHex } from './gradient.js';
import defaultConfig from './default-config.json';

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class EditorUI {
  constructor(heatmap, viewer) {
    this.heatmap = heatmap;
    this.viewer = viewer;
    this.activeStop = 0;
    this.defaultRadius = viewer.modelRadius * 0.22;

    this.zoneSource = null; // current map url, so Flip V can reload it

    this._buildSelects();
    this._bindSliders();
    this._bindGrid();
    this._bindMark();
    this._bindLight();
    this._bindZone();
    this._bindGradient();
    this._bindPoints();
    this._bindData();
    this._bindPanel();

    viewer.onPickModel = (p, n) => {
      this.addPointAt(p, n);
      this.revealSelectedPoint();
    };
    viewer.onSelect = (id) => {
      this.refreshAll();
      if (id != null) this.revealSelectedPoint();
    };

    this.refreshAll();
  }

  // ---- construction -------------------------------------------------------

  _buildSelects() {
    const preset = $('preset');
    for (const [id, p] of Object.entries(PRESETS)) {
      preset.append(new Option(p.label, id));
    }
    preset.append(new Option('Custom', 'custom'));
    preset.value = this.heatmap.presetId;
    preset.addEventListener('change', () => {
      if (preset.value === 'custom') return;
      this.heatmap.applyPreset(preset.value);
      this.activeStop = 0;
      this.refreshGradient();
    });

    const blend = $('blend');
    for (const m of BLEND_MODES) blend.append(new Option(m.label, String(m.id)));
    blend.value = String(this.heatmap.settings.blend);
    blend.addEventListener('change', () => {
      const id = Number(blend.value);
      this.heatmap.set('blend', id);
      $('blend-hint').textContent = BLEND_MODES[id].hint;
    });
    $('blend-hint').textContent = BLEND_MODES[this.heatmap.settings.blend].hint;
  }

  /** Wires a range input to its numeric readout and the matching setter. */
  _slider(id, valId, apply, fmt = (v) => v.toFixed(2)) {
    const el = $(id);
    const out = $(valId);
    const onInput = () => {
      const v = parseFloat(el.value);
      out.textContent = fmt(v);
      apply(v);
    };
    el.addEventListener('input', onInput);
    return {
      el,
      set: (v) => {
        el.value = String(v);
        out.textContent = fmt(v);
      },
    };
  }

  _bindSliders() {
    const hm = this.heatmap;

    this.sSize = this._slider('size', 'size-val', (v) => hm.set('sizeScale', v), (v) => `${v.toFixed(2)}×`);
    this.sFalloff = this._slider('falloff', 'falloff-val', (v) => hm.set('falloff', v));
    this.sIntensity = this._slider('intensity', 'intensity-val', (v) => hm.set('intensity', v));
    this.sOpacity = this._slider('opacity', 'opacity-val', (v) => hm.set('opacity', v));
    this.sFloor = this._slider('floor', 'floor-val', (v) => hm.set('floor', v));
    this.sDesat = this._slider('desat', 'desat-val', (v) => hm.set('desat', v));

    // radius and coverage act on the selected point
    const r = $('radius');
    const rMax = this.viewer.modelRadius * 1.6;
    r.min = String(rMax / 200);
    r.max = String(rMax);
    r.step = String(rMax / 400);
    this.sRadius = this._slider(
      'radius',
      'radius-val',
      (v) => this._editSelected((p) => (p.radius = v)),
      (v) => v.toFixed(3)
    );
    this.sWeight = this._slider('weight', 'weight-val', (v) =>
      this._editSelected((p) => (p.weight = v))
    );
    this.sLevel = this._slider('level', 'level-val', (v) =>
      this._editSelected((p) => (p.level = v))
    );

    $('color-mode').addEventListener('change', (e) => {
      hm.set('colorMode', e.target.value);
      this._colorModeHint();
      this.viewer.refreshMarkers(); // marker color depends on the mode
    });

    // Axes of the selected point. The range comes from the model's real bounding
    // box, with a margin, so the slider spans exactly the body.
    const half = this.viewer.modelHalf;
    this.axisSliders = {};
    for (const [axis, id] of [['x', 'px'], ['y', 'py'], ['z', 'pz']]) {
      const limit = (half?.[axis] ?? 1) * 1.25;
      const el = $(id);
      el.min = String(-limit);
      el.max = String(limit);
      el.step = String(limit / 500);
      this.axisSliders[axis] = this._slider(
        id,
        `${id}-val`,
        (v) => this._editSelected((p) => (p[axis] = v), true),
        (v) => v.toFixed(3)
      );
    }

    // Point shape: 1/1/1 is a sphere, any other combination makes it an ellipsoid
    this.shapeSliders = {};
    for (const key of ['sx', 'sy', 'sz']) {
      this.shapeSliders[key] = this._slider(
        key,
        `${key}-val`,
        (v) => this._editSelected((p) => (p[key] = v)),
        (v) => `${v.toFixed(2)}×`
      );
    }

    // Keyboard: move the selected point without letting go of the model
    window.addEventListener('keydown', (e) => {
      const point = hm.getPoint(this.viewer.selectedId);
      if (!point) return;
      // do not steal the arrows while a panel control has focus
      const focused = e.target;
      if (focused instanceof Element && focused.matches('input, select, textarea')) return;
      const step = (this.viewer.modelRadius || 1) * (e.altKey ? 0.002 : 0.01);
      const move = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1], ArrowUp: [null, 1], ArrowDown: [null, -1] };
      const hit = move[e.key];
      if (!hit) return;
      e.preventDefault();
      const axis = hit[0] ?? (e.shiftKey ? 'z' : 'y');
      point[axis] += hit[1] * step;
      this.viewer.refreshPointNormal(point);
      hm.sync();
      this.viewer.refreshMarkers();
      this.refreshSelected();
      this.refreshPointList();
    });

  }

  _colorModeHint() {
    $('color-mode-hint').textContent =
      this.heatmap.settings.colorMode === 'perPoint'
        ? 'Every point carries its own pain level and that is its color. A point that does not hurt paints green with the same presence as one that hurts a lot paints red.'
        : 'Classic heatmap: the color comes from how much heat piled up. Where there is little, the color ends up faint as well as cold.';
  }

  // ---- grid ---------------------------------------------------------------

  _bindGrid() {
    const hm = this.heatmap;
    this.sGridDensity = this._slider('grid-density', 'grid-density-val',
      (v) => hm.set('gridDensity', v), (v) => String(Math.round(v)));
    this.sGridWidth = this._slider('grid-width', 'grid-width-val',
      (v) => hm.set('gridWidth', v), (v) => v.toFixed(3));
    this.sGridOpacity = this._slider('grid-opacity', 'grid-opacity-val',
      (v) => hm.set('gridOpacity', v));
    this.sGridRot = this._slider('grid-rot', 'grid-rot-val',
      (v) => hm.set('gridRotation', v), (v) => `${Math.round(v)}°`);
    this.sGridAspect = this._slider('grid-aspect', 'grid-aspect-val',
      (v) => hm.set('gridAspect', v));

    $('grid-style').addEventListener('change', (e) => hm.set('gridStyle', Number(e.target.value)));

    $('grid-source').addEventListener('change', (e) => {
      if (e.target.value === 'pattern' && !hm.gridTexture) {
        e.target.value = 'lines';
        this.flash('Load a pattern image first');
        return;
      }
      hm.set('gridSource', e.target.value);
      this._gridSourceHint();
    });
    $('grid-load').addEventListener('click', () => $('grid-file').click());
    $('grid-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this.loadGridPattern(URL.createObjectURL(file));
      e.target.value = '';
    });

    $('grid-mode').addEventListener('change', (e) => {
      hm.set('gridMode', e.target.value);
      this._gridModeHint();
    });
    $('grid-on').addEventListener('change', (e) => hm.set('gridOn', e.target.checked));
    $('grid-zone-only').addEventListener('change', (e) => hm.set('gridZoneOnly', e.target.checked));
    $('grid-color').addEventListener('input', (e) => hm.set('gridColor', e.target.value));
  }

  /** Loads a tileable pattern and switches the grid over to it. */
  async loadGridPattern(url) {
    try {
      this.heatmap.setGridTexture(await this.viewer.loadGridTexture(url));
      this.heatmap.set('gridSource', 'pattern');
      this.refreshAll();
      return true;
    } catch (err) {
      this.flash(`Could not load the pattern: ${err.message}`);
      return false;
    }
  }

  _gridSourceHint() {
    const usingPattern = this.heatmap.settings.gridSource === 'pattern';
    $('grid-width').disabled = usingPattern; // the pattern carries its own line width
    $('grid-style').disabled = usingPattern;
  }

  _gridModeHint() {
    $('grid-mode-hint').textContent =
      this.heatmap.settings.gridMode === 'triplanar'
        ? 'Cells defined in the model 3D space: same size and orientation across the whole body, no seams.'
        : 'Cells defined over the UVs. On this model the UVs are auto generated islands, so they come out rotated and at a different size on every part.';
  }

  // ---- lighting -----------------------------------------------------------

  _bindLight() {
    const v = this.viewer;
    this.sKey = this._slider('light-key', 'light-key-val', (x) => v.setLight('keyIntensity', x));
    this.sAz = this._slider('light-az', 'light-az-val',
      (x) => v.setLight('azimuth', x), (x) => `${Math.round(x)}°`);
    this.sEl = this._slider('light-el', 'light-el-val',
      (x) => v.setLight('elevation', x), (x) => `${Math.round(x)}°`);
    this.sFill = this._slider('light-fill', 'light-fill-val', (x) => v.setLight('fillIntensity', x));
    this.sEnv = this._slider('light-env', 'light-env-val', (x) => v.setLight('envIntensity', x));
    this.sExp = this._slider('light-exp', 'light-exp-val', (x) => v.setLight('exposure', x));
    this.sSoft = this._slider('light-soft', 'light-soft-val',
      (x) => v.setLight('shadowSoftness', x), (x) => x.toFixed(1));
    this.sShOpacity = this._slider('light-shopacity', 'light-shopacity-val',
      (x) => v.setLight('shadowOpacity', x));

    $('light-color').addEventListener('input', (e) => v.setLight('keyColor', e.target.value));
    $('light-shadows').addEventListener('change', (e) => v.setLight('shadows', e.target.checked));
    $('light-ground').addEventListener('change', (e) => v.setLight('ground', e.target.checked));
  }

  // ---- zone map -----------------------------------------------------------

  _bindZone() {
    const hm = this.heatmap;

    $('zone-load').addEventListener('click', () => $('zone-file').click());
    $('zone-file').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.loadZone(URL.createObjectURL(file), file.name);
      e.target.value = '';
    });

    $('zone-clear').addEventListener('click', () => {
      if (this.zoneSource?.startsWith('blob:')) URL.revokeObjectURL(this.zoneSource);
      this.zoneSource = null;
      hm.setZoneTexture(null); // back to keying against the model texture
      $('zone-name').textContent = "Using the model's own texture";
      this.refreshAll();
    });

    $('zone-on').addEventListener('change', (e) => hm.set('zoneOn', e.target.checked));

    $('zone-key').addEventListener('input', (e) => hm.set('zoneKey', e.target.value));
    $('zone-flat').addEventListener('input', (e) => hm.set('zoneFlat', e.target.value));
    $('zone-armor').addEventListener('input', (e) => hm.set('zoneArmor', e.target.value));
    $('zone-invert').addEventListener('change', (e) => hm.set('zoneInvert', e.target.checked));
    $('zone-debug').addEventListener('change', (e) => hm.set('zoneDebug', e.target.checked));
    $('zone-flip').addEventListener('change', () => {
      if (this.zoneSource) this.loadZone(this.zoneSource, $('zone-name').textContent);
    });

    this._slider('zone-tol', 'zone-tol-val', (v) => hm.set('zoneTol', v));
    this._slider('zone-soft', 'zone-soft-val', (v) => hm.set('zoneSoft', v));
  }

  /** Loads a zone map and turns it on. `label` is only for the panel readout. */
  async loadZone(url, label) {
    try {
      const tex = await this.viewer.loadZoneTexture(url, $('zone-flip').checked);
      this.zoneSource = url;
      this.heatmap.setZoneTexture(tex);
      this.heatmap.set('zoneOn', true);
      $('zone-name').textContent = `${label} · ${tex.image.width}×${tex.image.height}`;
      this.refreshAll();
      return true;
    } catch (err) {
      this.flash(`Could not load the map: ${err.message}`);
      return false;
    }
  }

  _editSelected(fn, moved = false) {
    const p = this.heatmap.getPoint(this.viewer.selectedId);
    if (!p) return;
    fn(p);
    // after moving it the stored normal is stale: look up the new surface one
    if (moved) this.viewer.refreshPointNormal(p);
    this.heatmap.sync();
    this.viewer.refreshMarkers();
    this.refreshPointList();
  }

  // ---- per point markers --------------------------------------------------

  _bindMark() {
    const hm = this.heatmap;
    // the overlay is rebuilt on every change: it is at most 64 nodes
    const apply = (key) => (v) => {
      hm.set(key, v);
      this.viewer.refreshMarkers();
    };
    const px = (v) => `${Math.round(v)} px`;
    this.sMarkSize = this._slider('mark-size', 'mark-size-val', apply('markSize'), px);
    this.sMarkDot = this._slider('mark-dot', 'mark-dot-val', apply('markDot'), px);
    this.sMarkBorder = this._slider('mark-border', 'mark-border-val', apply('markBorder'), px);
    this.sMarkOpacity = this._slider('mark-opacity', 'mark-opacity-val', apply('markOpacity'));
    $('mark-on').addEventListener('change', (e) => apply('markOn')(e.target.checked));
    $('mark-hide').addEventListener('change', (e) => apply('markHideBehind')(e.target.checked));
    $('mark-color').addEventListener('input', (e) => apply('markColor')(e.target.value));
    $('mark-pain').addEventListener('change', (e) => apply('markUsePain')(e.target.checked));
  }

  // ---- gradiente ----------------------------------------------------------

  _bindGradient() {
    const bar = $('grad-bar');

    // clicking the bar (outside a stop) adds one with the color at that spot
    bar.addEventListener('pointerdown', (e) => {
      if (e.target !== bar && e.target.id !== 'grad-stops') return;
      const rect = bar.getBoundingClientRect();
      this.addStopAt(clamp01((e.clientX - rect.left) / rect.width));
    });

    $('stop-color').addEventListener('input', (e) => {
      const stops = this.heatmap.stops;
      if (!stops[this.activeStop]) return;
      stops[this.activeStop].color = e.target.value;
      this.heatmap.setStops(stops);
      this._markCustom();
      this.refreshGradient();
    });

    this._slider(
      'stop-pos',
      'stop-pos-val',
      (v) => {
        const stops = this.heatmap.stops;
        if (!stops[this.activeStop]) return;
        stops[this.activeStop].pos = v;
        this.heatmap.setStops(stops);
        this._markCustom();
        this.refreshGradient();
      },
      (v) => v.toFixed(2)
    );

    $('stop-add').addEventListener('click', () => this.addStopAt(null));
    $('stop-del').addEventListener('click', () => {
      const stops = this.heatmap.stops;
      if (stops.length <= 2) return;
      stops.splice(this.activeStop, 1);
      this.activeStop = Math.max(0, this.activeStop - 1);
      this.heatmap.setStops(stops);
      this._markCustom();
      this.refreshGradient();
    });
  }

  _markCustom() {
    this.heatmap.presetId = 'custom';
    $('preset').value = 'custom';
  }

  /** Exact ramp color at t (0..1), read from the already generated texture. */
  sampleGradient(t) {
    const data = this.heatmap.gradient.data;
    const n = data.length / 4;
    const i = Math.round(clamp01(t) * (n - 1)) * 4;
    return rgbToHex(data[i], data[i + 1], data[i + 2]);
  }

  addStopAt(pos) {
    const stops = this.heatmap.stops;
    let t = pos;
    if (t == null) {
      // with no explicit position: the widest gap between stops
      const s = sortStops(stops);
      let best = 0.5;
      let gap = -1;
      for (let i = 0; i < s.length - 1; i++) {
        const g = s[i + 1].pos - s[i].pos;
        if (g > gap) {
          gap = g;
          best = (s[i].pos + s[i + 1].pos) / 2;
        }
      }
      t = best;
    }
    const created = { pos: t, color: this.sampleGradient(t) };
    stops.push(created);
    const sorted = sortStops(stops);
    this.activeStop = Math.max(0, sorted.indexOf(created));
    this.heatmap.setStops(sorted);
    this._markCustom();
    this.refreshGradient();
  }

  refreshGradient() {
    const stops = this.heatmap.stops;
    $('grad-bar').style.background = stopsToCss(stops);
    $('preset').value = PRESETS[this.heatmap.presetId] ? this.heatmap.presetId : 'custom';

    const host = $('grad-stops');
    host.innerHTML = '';
    stops.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'grad-stop' + (i === this.activeStop ? ' active' : '');
      el.style.left = `${s.pos * 100}%`;
      el.style.background = s.color;
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.activeStop = i;
        this.refreshGradient();
        this._dragStop(i, e);
      });
      host.append(el);
    });

    const cur = stops[this.activeStop] || stops[0];
    if (cur) {
      $('stop-color').value = cur.color;
      $('stop-pos').value = String(cur.pos);
      $('stop-pos-val').textContent = cur.pos.toFixed(2);
    }
    $('stop-del').disabled = stops.length <= 2;
  }

  _dragStop(index, downEvent) {
    const bar = $('grad-bar');
    const rect = bar.getBoundingClientRect();

    const move = (e) => {
      const t = clamp01((e.clientX - rect.left) / rect.width);
      const stops = this.heatmap.stops;
      stops[index].pos = t;
      this.heatmap.setStops(stops);
      this._markCustom();
      this.refreshGradient();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // reorder once on release, so the index survives the drag
      const stops = sortStops(this.heatmap.stops);
      const cur = this.heatmap.stops[index];
      this.activeStop = stops.indexOf(cur);
      this.heatmap.setStops(stops);
      this.refreshGradient();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(downEvent);
  }

  // ---- points -------------------------------------------------------------

  _bindPoints() {
    $('pt-clear').addEventListener('click', () => {
      this.heatmap.clearPoints();
      this.viewer.select(null);
      this.refreshAll();
    });

    $('pt-random').addEventListener('click', () => this.seedRandom(8));
    $('pt-duplicate').addEventListener('click', () => this.duplicateSelected());

    window.addEventListener('keydown', (e) => {
      if (!(e.key === 'd' || e.key === 'D') || !(e.ctrlKey || e.metaKey)) return;
      const focused = e.target;
      if (focused instanceof Element && focused.matches('input, select, textarea')) return;
      e.preventDefault();
      this.duplicateSelected();
    });
  }

  /** Copies the selected point with all its settings and selects the new one. */
  duplicateSelected() {
    const source = this.heatmap.getPoint(this.viewer.selectedId);
    if (!source) {
      this.flash('Select a point to duplicate it');
      return null;
    }
    if (this.heatmap.points.length >= MAX_POINTS) {
      this.flash(`At most ${MAX_POINTS} points`);
      return null;
    }
    // offset a bit so it is visible and grabbable, not on top of the original
    const copy = this.heatmap.duplicatePoint(source.id, this.viewer.modelRadius * 0.09);
    if (copy) {
      this.viewer.refreshPointNormal(copy); // the original's normal no longer applies
      this.heatmap.sync();
      this.viewer.select(copy.id);
    }
    this.refreshAll();
    return copy;
  }

  addPointAt(vec3, normal) {
    if (this.heatmap.points.length >= MAX_POINTS) {
      this.flash(`At most ${MAX_POINTS} points`);
      return null;
    }
    const p = this.heatmap.addPoint({
      x: vec3.x,
      y: vec3.y,
      z: vec3.z,
      radius: this.defaultRadius,
      weight: 1,
      nx: normal?.x ?? 0,
      ny: normal?.y ?? 0,
      nz: normal?.z ?? 1,
    });
    this.viewer.select(p.id);
    this.refreshAll();
    return p;
  }

  /** Scatters points on real model vertices, so they always land on the surface. */
  seedRandom(n) {
    const mesh = this.viewer.meshes[0];
    if (!mesh) return;
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < n && this.heatmap.points.length < MAX_POINTS; i++) {
      const v = Math.floor(Math.random() * pos.count);
      this.heatmap.addPoint({
        x: pos.getX(v),
        y: pos.getY(v),
        z: pos.getZ(v),
        radius: this.defaultRadius * (0.7 + Math.random() * 0.7),
        weight: 0.8 + Math.random() * 0.5,
      });
    }
    this.refreshAll();
  }

  refreshPointList() {
    const list = $('pt-list');
    const points = this.heatmap.points;
    $('pt-count').textContent = String(points.length);
    list.innerHTML = '';

    if (!points.length) {
      const li = document.createElement('li');
      li.className = 'pt-empty';
      li.textContent = 'No points yet. Click the model to add one.';
      list.append(li);
      return;
    }

    points.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = p.id === this.viewer.selectedId ? 'active' : '';
      li.innerHTML =
        `<span class="dot"></span>` +
        `<span class="nm">#${i + 1} · r ${p.radius.toFixed(3)} · w ${p.weight.toFixed(2)}</span>`;

      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.textContent = '✕';
      rm.title = 'Delete point';
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        this.heatmap.removePoint(p.id);
        if (this.viewer.selectedId === p.id) this.viewer.select(null);
        this.refreshAll();
      });
      li.append(rm);

      li.addEventListener('click', () => {
        this.viewer.select(p.id);
        this.refreshAll();
      });
      list.append(li);
    });
  }

  refreshSelected() {
    const p = this.heatmap.getPoint(this.viewer.selectedId);
    const box = $('sel-point');
    const i = this.heatmap.points.indexOf(p);

    box.classList.toggle('empty', !p);
    $('sel-name').textContent = p ? `#${i + 1}` : 'ninguno';
    const ids = ['radius', 'weight', 'level', 'px', 'py', 'pz', 'sx', 'sy', 'sz'];
    for (const id of ids) $(id).disabled = !p;
    $('pt-duplicate').disabled = !p;

    if (p) {
      this.sRadius.set(p.radius);
      this.sWeight.set(p.weight);
      this.sLevel.set(p.level ?? 1);
      this.axisSliders.x.set(p.x);
      this.axisSliders.y.set(p.y);
      this.axisSliders.z.set(p.z);
      this.shapeSliders.sx.set(p.sx ?? 1);
      this.shapeSliders.sy.set(p.sy ?? 1);
      this.shapeSliders.sz.set(p.sz ?? 1);
    } else {
      for (const id of ids) $(`${id}-val`).textContent = '—';
    }
  }

  // ---- data ---------------------------------------------------------------

  /** The exported JSON covers the whole scene: heatmap, grid and lighting. */
  getConfig() {
    return { ...this.heatmap.toJSON(), lighting: this.viewer.getLighting() };
  }

  applyConfig(cfg) {
    this.heatmap.fromJSON(cfg);
    // Normals in the file may be stale (a point that was duplicated and then moved
    // keeps the original's), so they get recomputed against the surface.
    for (const point of this.heatmap.points) this.viewer.refreshPointNormal(point);
    if (cfg.lighting) this.viewer.setLighting(cfg.lighting);
    this.activeStop = 0;
    this.viewer.select(null);
    this.refreshAll();
  }

  _bindData() {
    $('cfg-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.getConfig(), null, 2)], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'heatmap-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $('cfg-import').addEventListener('click', () => $('cfg-file').click());
    $('cfg-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        this.applyConfig(JSON.parse(await file.text()));
      } catch (err) {
        this.flash(`Could not import: ${err.message}`);
      }
      e.target.value = '';
    });

    $('cfg-reset').addEventListener('click', () => {
      this.heatmap.clearPoints();
      this.applyConfig(defaultConfig);
      this.viewer.frame();
    });

    $('shot').addEventListener('click', () => {
      const v = this.viewer;
      v.renderer.render(v.scene, v.camera);
      const a = document.createElement('a');
      a.href = v.renderer.domElement.toDataURL('image/png');
      a.download = 'heatmap.png';
      a.click();
    });
  }

  _bindPanel() {
    const panel = $('panel');
    const toggle = $('panel-toggle');
    const hide = () => {
      panel.classList.add('hidden');
      toggle.classList.add('show');
    };
    const show = () => {
      panel.classList.remove('hidden');
      toggle.classList.remove('show');
    };
    $('panel-close').addEventListener('click', hide);
    toggle.addEventListener('click', show);

    $('panel-expand').addEventListener('click', () => {
      const groups = [...panel.querySelectorAll('details.group')];
      // if any is collapsed open them all; if all are open collapse them
      const openAll = groups.some((g) => !g.open);
      groups.forEach((g) => (g.open = openAll));
    });

    // When a point gets selected the Points section should be open, otherwise its
    // sliders stay hidden and it looks like nothing happened.
    this.pointsGroup = $('pt-list').closest('details.group');
  }

  /** Opens the Points section and scrolls the selected point into view. */
  revealSelectedPoint() {
    if (!this.pointsGroup) return;
    this.pointsGroup.open = true;
    $('sel-point').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  flash(msg) {
    const el = $('hud-stats');
    const prev = el.textContent;
    el.textContent = msg;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => (el.textContent = prev), 2200);
  }

  // ---- global refresh -----------------------------------------------------

  refreshAll() {
    const s = this.heatmap.settings;
    this.sSize.set(s.sizeScale);
    this.sFalloff.set(s.falloff);
    this.sIntensity.set(s.intensity);
    this.sOpacity.set(s.opacity);
    this.sFloor.set(s.floor);
    this.sDesat.set(s.desat);
    $('color-mode').value = s.colorMode;
    this._colorModeHint();

    $('zone-on').checked = s.zoneOn && this.heatmap.hasZoneSource();
    $('zone-key').value = s.zoneKey;
    $('zone-flat').value = s.zoneFlat;
    $('zone-armor').value = s.zoneArmor;
    $('zone-invert').checked = s.zoneInvert;
    $('zone-debug').checked = s.zoneDebug;
    this.sGridDensity.set(s.gridDensity);
    this.sGridWidth.set(s.gridWidth);
    this.sGridOpacity.set(s.gridOpacity);
    $('grid-on').checked = s.gridOn;
    $('grid-zone-only').checked = s.gridZoneOnly;
    $('grid-color').value = s.gridColor;
    $('grid-mode').value = s.gridMode;
    $('grid-source').value = this.heatmap.gridTexture ? s.gridSource : 'lines';
    this._gridSourceHint();
    $('grid-style').value = String(s.gridStyle);
    this.sGridRot.set(s.gridRotation);
    this.sGridAspect.set(s.gridAspect);
    this._gridModeHint();

    this.sMarkSize.set(s.markSize);
    this.sMarkDot.set(s.markDot);
    this.sMarkBorder.set(s.markBorder);
    this.sMarkOpacity.set(s.markOpacity);
    $('mark-on').checked = s.markOn;
    $('mark-hide').checked = s.markHideBehind;
    $('mark-color').value = s.markColor;
    $('mark-pain').checked = s.markUsePain;

    const L = this.viewer.lighting;
    this.sKey.set(L.keyIntensity);
    this.sAz.set(L.azimuth);
    this.sEl.set(L.elevation);
    this.sFill.set(L.fillIntensity);
    this.sEnv.set(L.envIntensity);
    this.sExp.set(L.exposure);
    this.sSoft.set(L.shadowSoftness);
    this.sShOpacity.set(L.shadowOpacity);
    $('light-color').value = L.keyColor;
    $('light-shadows').checked = L.shadows;
    $('light-ground').checked = L.ground;

    $('zone-tol').value = String(s.zoneTol);
    $('zone-tol-val').textContent = s.zoneTol.toFixed(2);
    $('zone-soft').value = String(s.zoneSoft);
    $('zone-soft-val').textContent = s.zoneSoft.toFixed(2);

    $('blend').value = String(s.blend);
    $('blend-hint').textContent = BLEND_MODES[s.blend].hint;

    this.refreshGradient();
    this.refreshSelected();
    this.refreshPointList();
    this.viewer.refreshMarkers();
  }
}
