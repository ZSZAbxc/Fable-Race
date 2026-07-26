import * as THREE from "three";
import type { CarConfig } from "@fable/shared";

export interface CarVisual {
  root: THREE.Group;
  /** 车轮组（转向 + 定位） */
  wheels: THREE.Group[];
  /** 轮胎网格（滚动自转） */
  spinners: THREE.Mesh[];
  /** 车身材质（换色用） */
  bodyMaterial: THREE.MeshStandardMaterial;
}

/**
 * 占位车模构建（本地车与远程车共用）。
 * Phase 7 换 Kenney glTF 时只改这里。
 */
export function buildCarVisual(config: CarConfig, color?: string): CarVisual {
  const root = new THREE.Group();
  const [hx, hy, hz] = config.chassis.halfExtents;
  const comY = config.chassis.centerOfMassY;

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color ?? config.color),
    roughness: 0.35,
    metalness: 0.25,
  });

  // 车身
  const body = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), bodyMaterial);
  body.position.y = comY;
  body.castShadow = true;
  root.add(body);

  // 座舱
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(hx * 1.5, hy * 1.1, hz * 0.85),
    new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.2, metalness: 0.4 })
  );
  cabin.position.set(0, comY + hy + hy * 0.5, -hz * 0.15);
  cabin.castShadow = true;
  root.add(cabin);

  // 车头标记（辨认方向）
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(hx * 0.8, hy * 0.4, 0.15),
    new THREE.MeshStandardMaterial({ color: 0xffe14d, roughness: 0.4 })
  );
  nose.position.set(0, comY, hz + 0.02);
  root.add(nose);

  // 四轮
  const w = config.wheels;
  const wheelGeo = new THREE.CylinderGeometry(w.radius, w.radius, w.width, 20);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xbfbfbf, roughness: 0.3 });

  const wheels: THREE.Group[] = [];
  const spinners: THREE.Mesh[] = [];
  const restPositions: [number, number, number][] = [
    [-w.halfTrack, w.connectionY - 0.3, w.frontZ],
    [w.halfTrack, w.connectionY - 0.3, w.frontZ],
    [-w.halfTrack, w.connectionY - 0.3, w.rearZ],
    [w.halfTrack, w.connectionY - 0.3, w.rearZ],
  ];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group();
    group.position.set(...restPositions[i]);
    const tire = new THREE.Mesh(wheelGeo, wheelMat);
    tire.castShadow = true;
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(w.radius * 0.55, w.radius * 0.55, w.width + 0.02, 12).rotateZ(Math.PI / 2),
      hubMat
    );
    tire.add(hub);
    group.add(tire);
    root.add(group);
    wheels.push(group);
    spinners.push(tire);
  }

  return { root, wheels, spinners, bodyMaterial };
}

/** 车顶名牌（远程玩家） */
export function buildNameTag(name: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.font = "bold 34px Consolas, 'Microsoft YaHei', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  ctx.fillText(name.slice(0, 12), 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  );
  sprite.scale.set(3.4, 0.85, 1);
  sprite.position.y = 1.9;
  sprite.renderOrder = 10;
  return sprite;
}
