import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { VehiclePhysics, type CarConfig, type SpawnPose } from "@fable/shared";
import { buildCarVisual, type CarVisual } from "./carVisual";

/**
 * 本地车辆实体 = VehiclePhysics（物理） + buildCarVisual（渲染）。
 */
export class CarEntity {
  readonly physics: VehiclePhysics;
  readonly root: THREE.Group;

  private visual: CarVisual;

  constructor(scene: THREE.Scene, world: RAPIER.World, config: CarConfig, spawn: SpawnPose, color?: string) {
    this.physics = new VehiclePhysics(world, config, spawn);
    this.visual = buildCarVisual(config, color);
    this.root = this.visual.root;
    scene.add(this.root);
    this.sync();
  }

  /** 每渲染帧调用：物理位姿 → 渲染 */
  sync(): void {
    const p = this.physics.position();
    const q = this.physics.rotation();
    this.root.position.set(p.x, p.y, p.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);

    for (let i = 0; i < 4; i++) {
      const s = this.physics.wheelVisual(i);
      const g = this.visual.wheels[i];
      g.position.set(s.localPosition.x, s.localPosition.y, s.localPosition.z);
      g.rotation.set(0, s.steering, 0);
      this.visual.spinners[i].rotation.x = s.rotation;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.root);
    this.physics.dispose();
  }
}
