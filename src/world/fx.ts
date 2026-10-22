import * as THREE from "three";
import { AMBER, BAD, GOOD, tokenModel, type TokenShape } from "./models";
import { discTexture } from "./textures";

/**
 * Short-lived things: the tokens that ride the belts (a call's arguments
 * going in, its result coming back) and puffs of smoke and sparks.
 */

export type TokenKind = "call" | "return" | "error";

const tokenMats: Record<TokenKind, THREE.MeshStandardMaterial> = {
  call: new THREE.MeshStandardMaterial({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.35, flatShading: true, vertexColors: true, roughness: 0.5 }),
  return: new THREE.MeshStandardMaterial({ color: GOOD, emissive: GOOD, emissiveIntensity: 0.3, flatShading: true, vertexColors: true, roughness: 0.5 }),
  error: new THREE.MeshStandardMaterial({ color: BAD, emissive: BAD, emissiveIntensity: 0.8, flatShading: true, vertexColors: true, roughness: 0.5 })
};

const haloMats: Record<TokenKind, THREE.SpriteMaterial> = {
  call: new THREE.SpriteMaterial({ map: discTexture(), color: AMBER, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  return: new THREE.SpriteMaterial({ map: discTexture(), color: GOOD, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  error: new THREE.SpriteMaterial({ map: discTexture(), color: BAD, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
};

interface Puff {
  s: THREE.Sprite;
  age: number;
  life: number;
  vel: THREE.Vector3;
  grow: number;
  alpha: number;
}

export class Fx {
  private puffs: Puff[] = [];
  constructor(private group: THREE.Group) {}

  /** A token, 1.5x life size so it reads at a distance, with a halo so it reads from far away. */
  token(shape: TokenShape, kind: TokenKind): THREE.Mesh {
    const m = new THREE.Mesh(tokenModel(shape), tokenMats[kind]);
    m.scale.setScalar(1.5);
    m.castShadow = true;
    const halo = new THREE.Sprite(haloMats[kind]);
    halo.scale.setScalar(0.9);
    halo.position.y = 0.2;
    m.add(halo);
    this.group.add(m);
    return m;
  }

  drop(m: THREE.Object3D): void {
    this.group.remove(m);
  }

  smoke(at: THREE.Vector3, size: number): void {
    const mat = new THREE.SpriteMaterial({ map: discTexture(), color: 0xb9b3a8, transparent: true, depthWrite: false, opacity: 0.5 });
    this.add(mat, at, size, new THREE.Vector3((Math.random() - 0.5) * 0.3, 1.1, (Math.random() - 0.5) * 0.3), 1.6, 1.2, 0.5);
  }

  sparks(at: THREE.Vector3, color = BAD, n = 14): void {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({ map: discTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const a = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a) * 2.5, 2 + Math.random() * 3, Math.sin(a) * 2.5);
      this.add(mat, at, 0.25, v, 0.7, -0.5, 1);
    }
  }

  /** A ring of light on arrival (a dock receiving a response). */
  flash(at: THREE.Vector3, color: number, size = 2.5): void {
    const mat = new THREE.SpriteMaterial({ map: discTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.add(mat, at, size, new THREE.Vector3(), 0.5, 3, 0.9);
  }

  private add(mat: THREE.SpriteMaterial, at: THREE.Vector3, size: number, vel: THREE.Vector3, life: number, grow: number, alpha: number): void {
    const s = new THREE.Sprite(mat);
    s.position.copy(at);
    s.scale.setScalar(size);
    this.group.add(s);
    this.puffs.push({ s, age: 0, life, vel, grow, alpha });
  }

  update(dt: number): void {
    this.puffs = this.puffs.filter((p) => {
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        this.group.remove(p.s);
        p.s.material.dispose();
        return false;
      }
      p.s.position.addScaledVector(p.vel, dt);
      if (p.grow < 0) p.vel.y -= 9 * dt; // sparks fall
      p.s.scale.multiplyScalar(1 + Math.max(-0.9, p.grow * dt));
      p.s.material.opacity = p.alpha * (1 - k);
      return true;
    });
  }
}
