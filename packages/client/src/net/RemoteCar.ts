import * as THREE from "three";
import { INTERP_DELAY_MS, getCar } from "@fable/shared";
import { buildCarVisual, buildNameTag, type CarVisual } from "../vehicle/carVisual";

interface Snapshot {
  t: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/**
 * 远程玩家的车：无物理，按快照缓冲插值渲染（约 120ms 延迟换平滑）。
 */
export class RemoteCar {
  readonly root: THREE.Group;
  readonly name: string;
  readonly color: string;
  /** 已收到过快照（未出现过的车不参与近距提示） */
  live = false;

  private nameTag: THREE.Sprite;
  private visual: CarVisual;
  private buffer: Snapshot[] = [];
  private lastPos = new THREE.Vector3();
  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private wheelRadius: number;

  constructor(scene: THREE.Scene, carId: string, color: string, name: string) {
    const config = getCar(carId);
    this.wheelRadius = config.wheels.radius;
    this.name = name;
    this.color = color;
    this.visual = buildCarVisual(config, color);
    this.root = this.visual.root;
    this.nameTag = buildNameTag(name, color);
    this.root.add(this.nameTag);
    this.root.visible = false; // 等第一个快照
    scene.add(this.root);
  }

  /** 近距提示接管时隐藏世界内名牌，避免两层名字重叠 */
  setNameTagVisible(v: boolean): void {
    this.nameTag.visible = v;
  }

  /** 收到状态更新（来自 Colyseus onChange） */
  push(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    this.buffer.push({
      t: performance.now(),
      pos: new THREE.Vector3(x, y, z),
      quat: new THREE.Quaternion(qx, qy, qz, qw).normalize(),
    });
    // 只保留最近 1 秒
    const cutoff = performance.now() - 1000;
    while (this.buffer.length > 2 && this.buffer[0].t < cutoff) this.buffer.shift();
  }

  /** 每帧插值渲染 */
  update(dt: number): void {
    const buf = this.buffer;
    if (buf.length === 0) return;
    this.root.visible = true;
    this.live = true;

    const renderT = performance.now() - INTERP_DELAY_MS;

    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= renderT) {
        a = buf[i];
        b = buf[Math.min(i + 1, buf.length - 1)];
        break;
      }
    }

    if (a === b || b.t <= a.t) {
      this.tmpPos.copy(b.pos);
      this.tmpQuat.copy(b.quat);
    } else {
      const t = THREE.MathUtils.clamp((renderT - a.t) / (b.t - a.t), 0, 1.25); // 轻度外推
      this.tmpPos.lerpVectors(a.pos, b.pos, t);
      this.tmpQuat.slerpQuaternions(a.quat, b.quat, Math.min(t, 1));
    }

    this.root.position.copy(this.tmpPos);
    this.root.quaternion.copy(this.tmpQuat);

    // 车轮按位移滚动（视觉近似）
    const dist = this.tmpPos.distanceTo(this.lastPos);
    if (dt > 0 && dist < 5) {
      const spin = dist / this.wheelRadius;
      for (const s of this.visual.spinners) s.rotation.x += spin;
    }
    this.lastPos.copy(this.tmpPos);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.root);
  }
}
