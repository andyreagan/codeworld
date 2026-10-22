import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { groundTexture } from "./textures";

/**
 * Renderer, scene, light and camera. Light is mostly a warm late-afternoon
 * sun, so models read with lit tops and shaded flanks and their shadows
 * ground them; a hemisphere light and a little studio environment fill in.
 * The camera is an RTS camera: drag to pan, right-drag to orbit, wheel to
 * zoom, WASD/arrows to scroll.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  readonly sun: THREE.DirectionalLight;
  private keys = new Set<string>();
  /** Where the camera is gliding to (follow mode, focus clicks), if anywhere. */
  private glide: { target: THREE.Vector3; dist?: number } | null = null;

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    const bg = new THREE.Color(0x1d1a16);
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 90, 220);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    this.scene.add(new THREE.HemisphereLight(0xcfdcff, 0x5a4a36, 1.3));
    this.sun = new THREE.DirectionalLight(0xffe9c8, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.2, 600);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = 1.35;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 260;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener("start", () => (this.glide = null));

    addEventListener("resize", () => {
      this.camera.aspect = host.clientWidth / host.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(host.clientWidth, host.clientHeight);
      this.applyInset();
    });
    addEventListener("keydown", (e) => {
      if (!(e.target instanceof HTMLElement) || !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) this.keys.add(e.key.toLowerCase());
    });
    addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener("blur", () => this.keys.clear());
  }

  /** Ground under the world's bounds (and well past them). */
  ground(b: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 400;
    const tex = groundTexture();
    tex.repeat.set(size / 4, size / 4);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    g.rotation.x = -Math.PI / 2;
    g.position.set(cx, 0, cz);
    g.receiveShadow = true;
    this.scene.add(g);
    // the sun's shadow box covers the whole factory
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 12;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -span;
    cam.right = cam.top = span;
    cam.near = 1;
    cam.far = span * 4 + 80;
    cam.updateProjectionMatrix();
    // fog and reach scale with the factory, so a big one isn't lost in the haze
    const fog = this.scene.fog as THREE.Fog;
    fog.near = Math.max(90, span * 2.2);
    fog.far = Math.max(220, span * 5);
    this.camera.far = fog.far * 1.5;
    this.camera.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(260, span * 3.5);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx - span * 0.8, span * 1.6 + 30, cz + span * 1.1);
  }

  /** Keep the view's centre `px` pixels right of the canvas centre (the control room covers the left). */
  setInset(px: number): void {
    this.inset = px;
    this.applyInset();
  }

  private inset = 0;

  private applyInset(): void {
    const el = this.renderer.domElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (this.inset) this.camera.setViewOffset(w, h, -this.inset, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Frame the whole world from the south-west, looking north-east the way work flows. */
  frame(b: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const r = Math.max(b.maxX - b.minX, (b.maxZ - b.minZ) * this.camera.aspect) * 0.6 + 6;
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx - r * 0.25, r * 0.85, cz + r * 0.75);
    this.controls.update();
  }

  /** Glide the camera's focus to `p` (and to `dist` from it, if given). */
  focus(p: THREE.Vector3, dist?: number): void {
    this.glide = { target: p.clone(), dist };
  }

  /** Follow a moving point: nudge the focus there each frame. */
  follow(p: THREE.Vector3): void {
    this.glide = { target: p.clone(), dist: this.glide?.dist };
  }

  update(dt: number): void {
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    // keyboard scroll, faster when zoomed out
    const k = (this.keys.has("shift") ? 2.5 : 1) * off.length() * 0.9 * dt;
    const fwd = new THREE.Vector3(-off.x, 0, -off.z).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const mv = new THREE.Vector3();
    if (this.keys.has("w") || this.keys.has("arrowup")) mv.add(fwd);
    if (this.keys.has("s") || this.keys.has("arrowdown")) mv.sub(fwd);
    if (this.keys.has("d") || this.keys.has("arrowright")) mv.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) mv.sub(right);
    if (mv.lengthSq() > 0) {
      this.glide = null;
      mv.normalize().multiplyScalar(k);
      t.add(mv);
      this.camera.position.add(mv);
    }
    if (this.glide) {
      const a = 1 - Math.exp(-dt * 4);
      const step = this.glide.target.clone().sub(t).multiplyScalar(a);
      t.add(step);
      this.camera.position.add(step);
      if (this.glide.dist) {
        const d = off.length();
        off.setLength(d + (this.glide.dist - d) * a);
        this.camera.position.copy(t).add(off);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
