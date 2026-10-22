import * as THREE from "three";

/** Canvas-drawn textures and text labels. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Belt surface: dark rubber with chevrons pointing along +u (the direction of travel). */
export function beltTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = "#26282b";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#3a3d41";
  for (let x = 0; x < 64; x += 8) g.fillRect(x, 0, 3, 64);
  g.strokeStyle = "#c9a23c";
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(14, 8);
  g.lineTo(42, 32);
  g.lineTo(14, 56);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The ground: packed dirt with a faint tile grid, one texture tile = 4 world tiles. */
export function groundTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = "#4a4237";
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i++) {
    const v = 50 + rnd() * 40;
    g.fillStyle = `rgba(${v + 18},${v + 8},${v - 6},${0.25 + rnd() * 0.35})`;
    const s = 1 + rnd() * 4;
    g.fillRect(rnd() * 256, rnd() * 256, s, s);
  }
  g.strokeStyle = "rgba(0,0,0,0.18)";
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A soft round dot, for smoke and sparks. */
let disc: THREE.CanvasTexture | null = null;
export function discTexture(): THREE.CanvasTexture {
  if (disc) return disc;
  const [c, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.5)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  disc = new THREE.CanvasTexture(c);
  return disc;
}

export interface LabelOpts {
  /** World height of one line of text. */
  size?: number;
  color?: string;
  bg?: string;
  border?: string;
  font?: string;
}

/** A billboard text label (a sprite), `size` world units per line, its bottom centre at the sprite's position. */
export function label(text: string, o: LabelOpts = {}): THREE.Sprite {
  const lines = text.split("\n");
  const px = 48;
  const font = o.font ?? `600 ${px}px ui-monospace, "SF Mono", Menlo, monospace`;
  const [, m] = canvas(1, 1);
  m.font = font;
  const w = Math.ceil(Math.max(...lines.map((l) => m.measureText(l).width))) + px;
  const h = Math.ceil(lines.length * px * 1.2 + px * 0.5);
  const [c, g] = canvas(w, h);
  if (o.bg) {
    g.fillStyle = o.bg;
    g.beginPath();
    g.roundRect(2, 2, w - 4, h - 4, px * 0.25);
    g.fill();
    if (o.border) {
      g.strokeStyle = o.border;
      g.lineWidth = 4;
      g.stroke();
    }
  }
  g.font = font;
  g.fillStyle = o.color ?? "#f4efe2";
  g.textBaseline = "middle";
  g.textAlign = "center";
  lines.forEach((l, i) => g.fillText(l, w / 2, px * 0.25 + px * 0.6 + i * px * 1.2));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true });
  const s = new THREE.Sprite(mat);
  const k = (o.size ?? 0.5) / (px * 1.2);
  s.scale.set(w * k, h * k, 1);
  s.center.set(0.5, 0);
  return s;
}
