import RAPIER from "@dimforge/rapier3d-compat";
import type { CarConfig, SpawnPose, Vec3Like, VehicleInput } from "../types";

/** 用四元数旋转向量 (0,0,1) 得到车头朝向 */
export function forwardFromQuat(q: { x: number; y: number; z: number; w: number }): Vec3Like {
  return {
    x: 2 * (q.x * q.z + q.w * q.y),
    y: 2 * (q.y * q.z - q.w * q.x),
    z: 1 - 2 * (q.x * q.x + q.y * q.y),
  };
}

/** 用四元数旋转向量 (0,1,0) 得到车顶朝向 */
export function upFromQuat(q: { x: number; y: number; z: number; w: number }): Vec3Like {
  return {
    x: 2 * (q.x * q.y - q.w * q.z),
    y: 1 - 2 * (q.x * q.x + q.z * q.z),
    z: 2 * (q.y * q.z + q.w * q.x),
  };
}

export function yawToQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

const KMH = 1 / 3.6; // km/h -> m/s

/** 车轮索引：0 前左 / 1 前右 / 2 后左 / 3 后右 */
const FRONT_WHEELS = [0, 1];
const REAR_WHEELS = [2, 3];

export interface WheelVisualState {
  /** 车体局部坐标下的轮心位置 */
  localPosition: Vec3Like;
  /** 转向角（弧度） */
  steering: number;
  /** 累计滚动角（弧度） */
  rotation: number;
  inContact: boolean;
}

/**
 * 基于 Rapier DynamicRayCastVehicleController 的四轮射线悬挂载具。
 * 所有手感参数来自 CarConfig（shared/data/cars/*.json）。
 * 纯物理、无渲染依赖——客户端和冒烟测试共用。
 */
export class VehiclePhysics {
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly config: CarConfig;

  private world: RAPIER.World;
  private collider: RAPIER.Collider;
  private steerAngle = 0;
  private spawn: SpawnPose;
  /** 翻车持续时长（秒），超过阈值自动原地复位 */
  private flippedTime = 0;
  /** 上一物理步是否处于漂移状态（供音效/特效读取） */
  private driftActive = false;

  /** 翻车判定：车顶朝下 + 近乎静止，持续此时长后复位 */
  static readonly FLIP_RESET_DELAY = 2.0;

  /** 腾空时 pitch/roll 角速度阻尼系数（不作用于偏航） */
  private static readonly AIR_ANGULAR_DAMPING = 1800;
  /** 腾空时把车身拉回水平的恢复力矩强度 */
  private static readonly AIR_LEVELING_TORQUE = 2600;

  constructor(world: RAPIER.World, config: CarConfig, spawn: SpawnPose) {
    this.world = world;
    this.config = config;
    this.spawn = spawn;

    const c = config;
    const [hx, hy, hz] = c.chassis.halfExtents;

    const q = yawToQuat(spawn.yaw);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
      .setRotation(q)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    // 通过密度达到目标质量；碰撞盒略微下移 = 质心下移，防翻车
    const volume = 8 * hx * hy * hz;
    const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(0, c.chassis.centerOfMassY, 0)
      .setDensity(c.chassis.mass / volume)
      .setFriction(0.5)
      .setRestitution(0.1);
    this.collider = world.createCollider(colliderDesc, this.body);

    const ctrl = world.createVehicleController(this.body);
    ctrl.indexUpAxis = 1; // Y 向上
    ctrl.setIndexForwardAxis = 2; // Z 向前（rapier 0.14 的 setter 属性就叫这个名字）

    const w = c.wheels;
    const suspensionDir = { x: 0, y: -1, z: 0 };
    const axle = { x: -1, y: 0, z: 0 }; // 车轮轴向；方向正确性由冒烟测试验证
    const connections: Vec3Like[] = [
      { x: -w.halfTrack, y: w.connectionY, z: w.frontZ }, // FL
      { x: w.halfTrack, y: w.connectionY, z: w.frontZ }, // FR
      { x: -w.halfTrack, y: w.connectionY, z: w.rearZ }, // RL
      { x: w.halfTrack, y: w.connectionY, z: w.rearZ }, // RR
    ];

    for (let i = 0; i < 4; i++) {
      ctrl.addWheel(connections[i], suspensionDir, axle, c.suspension.restLength, w.radius);
      ctrl.setWheelSuspensionStiffness(i, c.suspension.stiffness);
      ctrl.setWheelSuspensionCompression(i, c.suspension.compression);
      ctrl.setWheelSuspensionRelaxation(i, c.suspension.relaxation);
      ctrl.setWheelMaxSuspensionTravel(i, c.suspension.travel);
      ctrl.setWheelMaxSuspensionForce(i, c.suspension.maxForce);
      ctrl.setWheelFrictionSlip(i, c.friction.slip);
      ctrl.setWheelSideFrictionStiffness(i, c.friction.sideStiffness);
    }
    this.controller = ctrl;
  }

  /** 带符号前进速度 (m/s)，正 = 向车头方向行驶 */
  forwardSpeed(): number {
    const v = this.body.linvel();
    const f = forwardFromQuat(this.body.rotation());
    return v.x * f.x + v.y * f.y + v.z * f.z;
  }

  speedKmh(): number {
    return Math.abs(this.forwardSpeed()) * 3.6;
  }

  position(): Vec3Like {
    return this.body.translation();
  }

  rotation(): { x: number; y: number; z: number; w: number } {
    return this.body.rotation();
  }

  yaw(): number {
    const f = forwardFromQuat(this.body.rotation());
    return Math.atan2(f.x, f.z);
  }

  /** 每个物理步调用一次；在 world.step() 之前 */
  update(input: VehicleInput, dt: number): void {
    const c = this.config;
    const ctrl = this.controller;
    const speed = this.forwardSpeed();
    const speedKmh = Math.abs(speed) * 3.6;

    // ---- 转向：速度越快最大转角越小 + 平滑逼近 ----
    const s = c.steering;
    const t = clamp(
      (speedKmh - s.fullSteerBelowKmh) / Math.max(1, s.minSteerAboveKmh - s.fullSteerBelowKmh),
      0,
      1
    );
    const maxDeg = s.maxAngleDeg + (s.highSpeedAngleDeg - s.maxAngleDeg) * t;
    const targetAngle = input.steer * (maxDeg * Math.PI) / 180;
    const blend = 1 - Math.exp(-s.lerpRate * dt);
    this.steerAngle += (targetAngle - this.steerAngle) * blend;
    for (const i of FRONT_WHEELS) ctrl.setWheelSteering(i, this.steerAngle);

    // ---- 油门 / 刹车 / 倒车 ----
    const maxSpeed = c.engine.maxSpeedKmh * KMH;
    const maxReverse = c.engine.reverseMaxSpeedKmh * KMH;
    let engineForce = 0;
    let brakeForce = 0;

    if (input.throttle > 0) {
      // 接近极速时驱动力衰减
      const falloff = 1 - Math.pow(clamp(Math.max(speed, 0) / maxSpeed, 0, 1), 3);
      engineForce = c.engine.maxForce * input.throttle * falloff;
    }
    if (input.brake > 0) {
      if (speed > 0.6) {
        brakeForce = c.engine.brakeForce * input.brake;
      } else {
        // 近停时按 S = 倒车
        const falloff = 1 - Math.pow(clamp(-speed / maxReverse, 0, 1), 3);
        engineForce = -c.engine.maxForce * 0.6 * input.brake * falloff;
      }
    }

    // ---- 滑行阻力：松开油门/刹车后用轻微轮刹模拟发动机制动+滚阻，自然减速到停 ----
    if (input.throttle === 0 && input.brake === 0 && !input.handbrake && Math.abs(speed) > 0.15) {
      brakeForce = c.engine.coastBrake;
    }

    // ---- 手刹：高速 = 影视漂移（保持动量、车头甩动），低速 = 后轮抱死 ----
    const d = c.drift;
    const drifting = input.handbrake && speedKmh > d.minSpeedKmh;
    this.driftActive = drifting;

    const brakes = [brakeForce * 1.1, brakeForce * 1.1, brakeForce * 0.9, brakeForce * 0.9];
    let frontSide = c.friction.sideStiffness;
    let rearSide = c.friction.sideStiffness;
    let engineScale = 1;

    if (drifting) {
      // 四轮侧向抓地大幅降低 → 速度方向近似保持；车头由甩动力矩控制
      frontSide = d.frontSideStiffness;
      rearSide = d.rearSideStiffness;
      engineScale = d.engineScale;
      for (let i = 0; i < 4; i++) brakes[i] = Math.max(brakes[i], d.brake);

      // 甩头力矩：仅在着地且未超最大角速度时施加
      let contacts = 0;
      for (let i = 0; i < 4; i++) if (ctrl.wheelIsInContact(i)) contacts++;
      const av = this.body.angvel();
      if (input.steer !== 0 && contacts >= 2 && Math.abs(av.y) < d.maxYawRate) {
        const factor = clamp(Math.abs(speed) / 12, 0, 1);
        this.body.applyTorqueImpulse({ x: 0, y: input.steer * d.yawTorque * factor * dt, z: 0 }, true);
      }
      // 硬限幅：轮胎力引发的自旋也一并限制，保证漂移角度可控不转陀螺
      const av2 = this.body.angvel();
      if (Math.abs(av2.y) > d.maxYawRate) {
        this.body.setAngvel({ x: av2.x, y: Math.sign(av2.y) * d.maxYawRate, z: av2.z }, true);
      }
    } else if (input.handbrake) {
      brakes[2] = Math.max(brakes[2], c.engine.handbrakeForce);
      brakes[3] = Math.max(brakes[3], c.engine.handbrakeForce);
    }

    const driven = c.drivetrain === "AWD" ? [0, 1, 2, 3] : c.drivetrain === "FWD" ? FRONT_WHEELS : REAR_WHEELS;
    const perWheel = (engineForce * engineScale) / driven.length;
    for (let i = 0; i < 4; i++) {
      ctrl.setWheelEngineForce(i, driven.includes(i) ? perWheel : 0);
      ctrl.setWheelBrake(i, brakes[i]);
      ctrl.setWheelSideFrictionStiffness(i, i < 2 ? frontSide : rearSide);
    }

    // ---- 下压力 F = k * v^2（腾空时大幅衰减，飞跃更舒展） ----
    const v = this.body.linvel();
    const planar = Math.sqrt(v.x * v.x + v.z * v.z);
    if (planar > 3) {
      let contacts = 0;
      for (let i = 0; i < 4; i++) if (ctrl.wheelIsInContact(i)) contacts++;
      const airScale = contacts >= 2 ? 1 : 0.3;
      const f = c.aero.downforce * planar * planar * airScale;
      this.body.applyImpulse({ x: 0, y: -f * dt, z: 0 }, true);
    }

    // ---- 腾空姿态稳定 ----
    // 峡谷断桥的长距离腾空（可达数秒）里车身没有任何支撑力矩，落地时往往已经
    // 翻扣，成功飞越的奖励会被「翻车 + 等扶正」抹掉。这里在四轮全离地时
    // 阻尼俯仰/横滚角速度，并施加一个把车身拉回水平的恢复力矩。
    // 只作用于 pitch/roll，偏航完全不碰 —— 空中甩尾调整车头的手感要保留。
    {
      let contacts = 0;
      for (let i = 0; i < 4; i++) if (ctrl.wheelIsInContact(i)) contacts++;
      if (contacts === 0) {
        const av = this.body.angvel();
        // 角速度阻尼（不含 y 轴）
        this.body.applyTorqueImpulse(
          {
            x: -av.x * VehiclePhysics.AIR_ANGULAR_DAMPING * dt,
            y: 0,
            z: -av.z * VehiclePhysics.AIR_ANGULAR_DAMPING * dt,
          },
          true
        );
        // 恢复力矩：车身 up 与世界 up 的叉积就是把车转正所需的旋转轴，
        // 幅度随倾斜角增大，水平时自然归零。
        const up = upFromQuat(this.body.rotation());
        const k = VehiclePhysics.AIR_LEVELING_TORQUE;
        this.body.applyTorqueImpulse({ x: -up.z * k * dt, y: 0, z: up.x * k * dt }, true);
      }
    }

    ctrl.updateVehicle(dt);

    // ---- 翻车检测：车顶朝下且基本停住，持续 2 秒后原地扶正 ----
    this.checkFlipRecovery(dt);
  }

  /** 是否处于翻车姿态（车顶明显朝下） */
  isFlipped(): boolean {
    return upFromQuat(this.body.rotation()).y < 0.15;
  }

  /** 上一物理步是否在漂移（手刹 + 速度达阈值） */
  isDrifting(): boolean {
    return this.driftActive;
  }

  /** 接地车轮数（0 = 四轮腾空） */
  contactCount(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) n++;
    return n;
  }

  private checkFlipRecovery(dt: number): void {
    const v = this.body.linvel();
    const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
    // 还在翻滚/坠落中不计时，等车停稳
    if (this.isFlipped() && speedSq < 4) {
      this.flippedTime += dt;
      if (this.flippedTime >= VehiclePhysics.FLIP_RESET_DELAY) {
        this.rightSelf();
      }
    } else {
      this.flippedTime = 0;
    }
  }

  /** 原地扶正：保留位置与朝向，抬高一点避免穿地 */
  private rightSelf(): void {
    const p = this.body.translation();
    this.reset({
      position: { x: p.x, y: p.y + 1.2, z: p.z },
      yaw: this.yaw(),
    });
  }

  /** 车轮渲染状态（车体局部坐标） */
  wheelVisual(i: number): WheelVisualState {
    const ctrl = this.controller;
    const conn = ctrl.wheelChassisConnectionPointCs(i) ?? { x: 0, y: 0, z: 0 };
    const rest = this.config.suspension.restLength;
    const len = ctrl.wheelSuspensionLength(i) ?? rest;
    return {
      localPosition: { x: conn.x, y: conn.y - len, z: conn.z },
      steering: ctrl.wheelSteering(i) ?? 0,
      rotation: ctrl.wheelRotation(i) ?? 0,
      inContact: ctrl.wheelIsInContact(i),
    };
  }

  /** 复位到出生点（或指定位姿） */
  reset(pose?: SpawnPose): void {
    const p = pose ?? this.spawn;
    this.body.setTranslation({ x: p.position.x, y: p.position.y, z: p.position.z }, true);
    this.body.setRotation(yawToQuat(p.yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.flippedTime = 0;
  }

  dispose(): void {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
  }
}
