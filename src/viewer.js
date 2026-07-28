import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const DRAG_THRESHOLD_PX = 5;

export class Viewer {
  constructor(canvas, heatmap) {
    this.canvas = canvas;
    this.heatmap = heatmap;

    // alpha: true leaves the background to CSS. Painting it into the scene means
    // it goes through tone mapping on the composer path but not on the direct one,
    // so turning AO on would visibly change the backdrop color.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene(); // background lives in CSS, see #view in style.css

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(0, 0.4, 3);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 30;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // Key light: the only one that casts a shadow.
    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    // Fill so the shadows do not close to black. Left colorless on purpose: a
    // tinted light skews how the heatmap colors read.
    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    this.fillLight.position.set(-2.5, 1, -2);
    this.scene.add(this.fillLight);

    // Invisible ground that only catches the cast shadow.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.35, transparent: true })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // Ambient occlusion. It runs as a post pass, which means giving up the
    // renderer's own MSAA -- so the composer target is multisampled by hand,
    // otherwise turning AO on would visibly jag every silhouette.
    this.composerTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, this.composerTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.blendIntensity = 1;
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());

    this.lighting = {
      keyIntensity: 2.4,
      keyColor: '#ffffff',
      azimuth: 35,
      elevation: 45,
      fillIntensity: 0.6,
      envIntensity: 0.85,
      exposure: 1.0,
      shadows: true,
      shadowSoftness: 3,
      shadowOpacity: 0.35,
      ground: true,
      ao: true,
      aoRadius: 0.25, // fraction of the model size, see applyLighting
      aoIntensity: 1,
    };
    this.applyLighting();

    this.model = null;
    this.meshes = [];
    this.modelRadius = 1;

    // The markers are an HTML UI overlay, not geometry: they keep the same size on
    // screen at any distance and never deform along the surface.
    this.markerHost = document.getElementById('markers');
    this._markerEls = [];
    this._tmp = new THREE.Vector3();
    this._tmpNormal = new THREE.Vector3();

    this.radiusGizmo = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.MeshBasicMaterial({
        color: 0x30e0ff,
        wireframe: true,
        transparent: true,
        opacity: 0.25,
        depthTest: false,
      })
    );
    this.radiusGizmo.visible = false;
    this.radiusGizmo.renderOrder = 3;

    this.selectedId = null;
    this.onPickModel = null; // (localPoint: Vector3) => void
    this.onSelect = null; // (id | null) => void

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._downPos = new THREE.Vector2();
    this._clock = new THREE.Clock();

    this._bindEvents();
    this.resize();
  }

  async load(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, (e) => {
      onProgress?.(e.total ? e.loaded / e.total : null, e.loaded);
    });

    const root = gltf.scene;
    root.updateMatrixWorld(true);

    // Flatten the hierarchy by baking the transforms into the geometries, so every
    // mesh shares one local space (the root's).
    const rootInv = root.matrixWorld.clone().invert();
    const meshes = [];
    root.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    for (const mesh of meshes) {
      const rel = new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld);
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.applyMatrix4(rel);
      mesh.position.set(0, 0, 0);
      mesh.quaternion.identity();
      mesh.scale.set(1, 1, 1);
      root.add(mesh);
    }

    // Center by baking the offset into the geometries, so the heat point coordinates
    // are the same ones shown in the editor.
    const box = new THREE.Box3();
    for (const mesh of meshes) {
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox);
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const recenter = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    for (const mesh of meshes) {
      mesh.geometry.applyMatrix4(recenter);
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true; // self shadowing: the arms onto the torso
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => this.heatmap.attach(m));
    }

    this.model = root;
    this.meshes = meshes;
    this.modelRadius = Math.max(size.x, size.y, size.z) * 0.5;
    this.modelBottom = -size.y * 0.5;
    this.modelHalf = size.clone().multiplyScalar(0.5); // range for the per axis sliders
    // makes the density slider mean "cells across the model" in both UV and
    // triplanar mode
    this.heatmap.uniforms.uGridWorldScale.value = 1 / Math.max(size.y, 1e-4);

    root.add(this.radiusGizmo);
    this.scene.add(root);

    this._buildNormalIndex();
    this.applyLighting(); // now that the real model size is known
    this.frame();
    return { size, triangles: this._countTriangles() };
  }

  /**
   * Indexes the vertices into a uniform grid so the nearest surface normal to a
   * point can be looked up quickly.
   *
   * Needed because the normal is stored when the point is placed, but the point can
   * later be moved with the sliders or duplicated; without recomputing it the normal
   * goes stale and "hide the ones facing away" hides markers that face the camera.
   */
  _buildNormalIndex() {
    this._normalCell = this.modelRadius / 12;
    this._normalGrid = new Map();
    this._normalMeshes = [];

    for (const mesh of this.meshes) {
      const position = mesh.geometry.attributes.position;
      const normal = mesh.geometry.attributes.normal;
      if (!position || !normal) continue;
      const meshIndex = this._normalMeshes.length;
      this._normalMeshes.push({ position, normal });

      for (let i = 0; i < position.count; i++) {
        const key = this._cellKey(position.getX(i), position.getY(i), position.getZ(i));
        let bucket = this._normalGrid.get(key);
        if (!bucket) this._normalGrid.set(key, (bucket = []));
        bucket.push(meshIndex, i);
      }
    }
  }

  _cellKey(x, y, z) {
    const c = this._normalCell;
    return `${Math.floor(x / c)},${Math.floor(y / c)},${Math.floor(z / c)}`;
  }

  /** Normal of the vertex nearest to (x,y,z), or null if nothing is around. */
  surfaceNormalAt(x, y, z) {
    if (!this._normalGrid) return null;
    const c = this._normalCell;
    const cx = Math.floor(x / c);
    const cy = Math.floor(y / c);
    const cz = Math.floor(z / c);

    let best = null;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this._normalGrid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k += 2) {
            const { position, normal } = this._normalMeshes[bucket[k]];
            const i = bucket[k + 1];
            const d =
              (position.getX(i) - x) ** 2 +
              (position.getY(i) - y) ** 2 +
              (position.getZ(i) - z) ** 2;
            if (d < bestDistance) {
              bestDistance = d;
              best = { x: normal.getX(i), y: normal.getY(i), z: normal.getZ(i) };
            }
          }
        }
      }
    }
    return best;
  }

  /** Recomputes a point's stored normal after moving or duplicating it. */
  refreshPointNormal(point) {
    const n = this.surfaceNormalAt(point.x, point.y, point.z);
    if (!n) return;
    point.nx = n.x;
    point.ny = n.y;
    point.nz = n.z;
  }

  /**
   * Loads the zone map. flipY is false because the GLB UVs follow the glTF
   * convention (origin at the top left), same as the base texture.
   */
  async loadZoneTexture(url, flipY = false) {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = flipY;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Loads the tileable grid pattern. Repeat wrapping is what makes the tiling
   * work, and max anisotropy keeps the weave from turning to mush at grazing
   * angles, which is where a fine pattern falls apart first.
   */
  async loadGridTexture(url) {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    return tex;
  }

  // ---- lighting -----------------------------------------------------------

  setLight(key, value) {
    if (!(key in this.lighting)) return;
    this.lighting[key] = value;
    this.applyLighting();
  }

  getLighting() {
    return { ...this.lighting };
  }

  setLighting(values) {
    for (const [k, v] of Object.entries(values || {})) {
      if (k in this.lighting) this.lighting[k] = v;
    }
    this.applyLighting();
  }

  /** Flushes `this.lighting` into the scene. Cheap: safe to call on every change. */
  applyLighting() {
    const L = this.lighting;
    const radius = this.modelRadius || 1;

    // azimuth/elevation instead of XYZ: that is what you actually want to move when
    // chasing a shadow, and it keeps the light at a constant distance
    const el = THREE.MathUtils.degToRad(L.elevation);
    const az = THREE.MathUtils.degToRad(L.azimuth);
    const distance = radius * 5;
    this.keyLight.position.set(
      distance * Math.cos(el) * Math.sin(az),
      distance * Math.sin(el),
      distance * Math.cos(el) * Math.cos(az)
    );
    this.keyLight.target.position.set(0, 0, 0);
    this.keyLight.target.updateMatrixWorld();

    this.keyLight.intensity = L.keyIntensity;
    this.keyLight.color.setStyle(L.keyColor, THREE.SRGBColorSpace);
    this.keyLight.castShadow = L.shadows;
    this.keyLight.shadow.radius = L.shadowSoftness;

    // the shadow camera has to enclose both the model and the ground
    const extent = radius * 1.8;
    const cam = this.keyLight.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = distance - radius * 3;
    cam.far = distance + radius * 3;
    cam.updateProjectionMatrix();

    this.fillLight.intensity = L.fillIntensity;
    this.scene.environmentIntensity = L.envIntensity;
    this.renderer.toneMappingExposure = L.exposure;

    this.ground.visible = L.ground && L.shadows;
    this.ground.material.opacity = L.shadowOpacity;
    this.ground.scale.setScalar(radius * 12);
    this.ground.position.y = (this.modelBottom ?? -radius) - radius * 0.005;

    this.gtao.enabled = L.ao;
    this.gtao.blendIntensity = L.aoIntensity;
    // The AO radius is in world units, so it is expressed as a fraction of the
    // model: the same setting then reads the same on a model of any scale.
    this.gtao.updateGtaoMaterial({
      radius: Math.max(L.aoRadius * radius, 1e-3),
      distanceExponent: 1,
      thickness: radius * 0.5,
      scale: 1,
      samples: 16,
    });
  }

  _countTriangles() {
    let n = 0;
    for (const m of this.meshes) {
      const g = m.geometry;
      n += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
    return Math.round(n);
  }

  frame() {
    const dist = (this.modelRadius / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.4;
    this.camera.position.set(dist * 0.3, this.modelRadius * 0.2, dist);
    this.controls.target.set(0, 0, 0);
    this.camera.near = Math.max(dist / 500, 0.001);
    this.camera.far = dist * 30;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.modelRadius * 0.15;
    this.controls.maxDistance = this.modelRadius * 40;
    this.controls.update();
  }

  // ---- interaction --------------------------------------------------------

  _bindEvents() {
    window.addEventListener('resize', () => this.resize());

    this.canvas.addEventListener('pointerdown', (e) => {
      this._downPos.set(e.clientX, e.clientY);
    });

    this.canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      const moved = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      if (moved > DRAG_THRESHOLD_PX) return; // that was an orbit/pan, not a click
      this._handleClick(e);
    });
  }

  _handleClick(event) {
    if (!this.model) return;

    const rect = this.canvas.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);

    const hit = this._raycaster.intersectObjects(this.meshes, false)[0];
    if (!hit) {
      this.select(null);
      this.onSelect?.(null);
      return;
    }
    const local = this.model.worldToLocal(hit.point.clone());

    // If the click lands within a point's marker, that point gets selected (shift
    // deletes it). Resolved by proximity rather than raycasting a floating sphere, so
    // the editor needs no extra geometry over the body.
    const reach = this.modelRadius * 0.06;
    let nearest = null;
    let nearestDistance = reach;
    for (const point of this.heatmap.points) {
      const d = Math.hypot(local.x - point.x, local.y - point.y, local.z - point.z);
      if (d <= nearestDistance) {
        nearest = point;
        nearestDistance = d;
      }
    }

    if (nearest) {
      if (event.shiftKey) {
        this.heatmap.removePoint(nearest.id);
        if (this.selectedId === nearest.id) this.selectedId = null;
        this.refreshMarkers();
      } else {
        this.select(nearest.id);
      }
      this.onSelect?.(this.selectedId);
      return;
    }

    // The face normal is stored with the point: it is what hides the marker when the
    // point ends up on the far side of the body. Expressed in root local space, which
    // is where every mesh is already baked.
    const normal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
    this.onPickModel?.(local, normal);
  }

  select(id) {
    this.selectedId = id;
    this.refreshMarkers();
  }

  /** Rebuilds the overlay nodes from the current points. */
  refreshMarkers() {
    if (!this.markerHost) return;
    const points = this.heatmap.points;
    const s = this.heatmap.settings;

    while (this._markerEls.length > points.length) {
      this._markerEls.pop().remove();
    }
    while (this._markerEls.length < points.length) {
      const el = document.createElement('div');
      el.className = 'joint';
      el.append(Object.assign(document.createElement('i'), { className: 'dot' }));
      this.markerHost.append(el);
      this._markerEls.push(el);
    }

    points.forEach((point, i) => {
      const el = this._markerEls[i];
      // the dot and the ring always share one color
      const color = s.markUsePain
        ? this.heatmap.colorAt(this.heatmap.painLevel(point))
        : s.markColor;
      el.style.width = `${s.markSize}px`;
      el.style.height = `${s.markSize}px`;
      el.style.borderWidth = `${s.markBorder}px`;
      el.style.borderColor = color;
      el.style.opacity = String(s.markOpacity);

      const dot = el.firstElementChild;
      dot.style.width = `${s.markDot}px`;
      dot.style.height = `${s.markDot}px`;
      dot.style.background = color;

      el.classList.toggle('selected', point.id === this.selectedId);
    });

    this.markerHost.style.display = s.markOn ? '' : 'none';
    this.updateMarkers();
  }

  /** Projects every point to screen coordinates. Called each frame. */
  updateMarkers() {
    if (!this.markerHost || !this.model || !this.heatmap.settings.markOn) return;

    // the rect is cached in resize(): reading it here forces a layout every frame,
    // right while the marker transforms are being written
    const rect = this._rect || (this._rect = this.canvas.getBoundingClientRect());
    const points = this.heatmap.points;

    for (let i = 0; i < points.length; i++) {
      const el = this._markerEls[i];
      if (!el) continue;
      const point = points[i];

      const world = this._tmp.set(point.x, point.y, point.z);
      this.model.localToWorld(world);

      // Facing away from the camera it gets hidden, otherwise markers on the far
      // side of the body would appear to float over the front.
      if (this.heatmap.settings.markHideBehind) {
        const normal = this._tmpNormal
          .set(point.nx ?? 0, point.ny ?? 0, point.nz ?? 1)
          .transformDirection(this.model.matrixWorld);
        if (normal.dot(world.clone().sub(this.camera.position).normalize()) > 0.15) {
          el.style.display = 'none';
          continue;
        }
      }

      world.project(this.camera);
      if (world.z > 1) {
        el.style.display = 'none';
        continue;
      }

      el.style.display = '';
      el.style.transform =
        `translate(-50%, -50%) translate(` +
        `${(world.x * 0.5 + 0.5) * rect.width}px, ${(-world.y * 0.5 + 0.5) * rect.height}px)`;
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // the composer works in device pixels, not CSS pixels
    const dpr = this.renderer.getPixelRatio();
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(dpr);
    this.gtao.setSize(w * dpr, h * dpr);
    this._rect = this.canvas.getBoundingClientRect();
  }

  /** Single entry point so every caller gets the same path, AO on or off. */
  render() {
    if (this.lighting.ao) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  start() {
    const tick = () => {
      requestAnimationFrame(tick);
      const sel = this.selectedId != null ? this.heatmap.getPoint(this.selectedId) : null;
      if (sel) {
        const r = this.heatmap.effectiveRadius(sel);
        this.radiusGizmo.visible = true;
        this.radiusGizmo.position.set(sel.x, sel.y, sel.z);
        // per axis scale: the gizmo shows the real ellipsoid, not a sphere
        this.radiusGizmo.scale.set(r * (sel.sx ?? 1), r * (sel.sy ?? 1), r * (sel.sz ?? 1));
      } else {
        this.radiusGizmo.visible = false;
      }

      this.controls.update();
      this.render();
      this.updateMarkers();
    };
    tick();
  }
}
