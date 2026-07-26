import RAPIER from "@dimforge/rapier3d-compat";
import { GRAVITY_Y, PHYSICS_DT } from "@fable/shared";

/** Rapier 世界 + 固定步长累加器 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  private accumulator = 0;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
    this.world.timestep = PHYSICS_DT;
  }

  /**
   * 以固定 60Hz 推进物理；onSubstep 在每个物理步 world.step() 前调用
   * （用于施加车辆力）。返回本帧实际推进的步数。
   */
  advance(frameDt: number, onSubstep: (dt: number) => void): number {
    // 切后台回来 dt 巨大，钳制避免螺旋死机
    this.accumulator += Math.min(frameDt, 0.1);
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < 5) {
      onSubstep(PHYSICS_DT);
      this.world.step();
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    // 依旧落后说明机器跑不动，丢弃积压
    if (this.accumulator >= PHYSICS_DT) this.accumulator = 0;
    return steps;
  }
}
