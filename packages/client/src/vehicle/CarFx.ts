import * as THREE from "three";
import type { VehiclePhysics } from "@fable/shared";

/**
 * 纯视觉特效：漂移烟雾 + 胎印。不读写任何物理量，不参与计圈与联机上报，
 * 删掉这个文件游戏行为完全不变。
 *
 * 两处都用固定容量的环形缓冲，运行期零分配、零 GC：
 * 粒子走单个 Points（一次 draw call），胎印走单个 LineSegments。
 */

/** 烟雾粒子上限。四轮同时冒烟约 40/秒，够铺满 2 秒尾迹 */
const SMOKE_MAX = 96;
/** 胎印线段上限。每轮每段约 0.1s，四轮合计约撑 12 秒历史 */
const SKID_MAX = 480;

const SMOKE_LIFE = 1.1;
const SMOKE_RISE = 1.4;
const SMOKE_SPREAD = 0.55;
/** 低于此速不出效果，免得停车原地手刹也在冒烟 */
const MIN_SPEED = 22;

export class CarFx {
  private smoke: THREE.Points;
  private smokePos: Float32Array;
  private smokeVel: Float32Array;
  private smokeAge: Float32Array;
  private smokeAlpha: Float32Array;
  private smokeScale: Float32Array;
  private smokeHead = 0;

  private skid: THREE.LineSegments;
  private skidPos: Float32Array;
  private skidAlpha: Float32Array;
  private skidHead = 0;
  /** 上一帧各轮触地点，用于把散点连成连续线段；null = 上一帧没在画 */
  private lastMark: (THREE.Vector3 | null)[] = [null, null, null, null];

  private emitAcc = 0;
  private tmp = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {
    // ---- 烟雾 ----
    this.smokePos = new Float32Array(SMOKE_MAX * 3);
    this.smokeVel = new Float32Array(SMOKE_MAX * 3);
    this.smokeAge = new Float32Array(SMOKE_MAX);
    this.smokeAlpha = new Float32Array(SMOKE_MAX);
    this.smokeScale = new Float32Array(SMOKE_MAX);
    // 全部初始化为已死亡（age >= life），首帧不显示
    this.smokeAge.fill(SMOKE_LIFE);

    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(this.smokePos, 3));
    sg.setAttribute("alpha", new THREE.BufferAttribute(this.smokeAlpha, 1));
    sg.setAttribute("pscale", new THREE.BufferAttribute(this.smokeScale, 1));

    // 自定义 shader：逐粒子控制透明度与尺寸，圆形柔边靠片元里的距离衰减
    const sm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: { uPixelRatio: { value: Math.min(devicePixelRatio, 2) } },
      vertexShader: `
        attribute float alpha;
        attribute float pscale;
        varying float vAlpha;
        uniform float uPixelRatio;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = pscale * uPixelRatio * 300.0 / max(-mv.z, 0.5);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float soft = smoothstep(0.5, 0.12, d);
          gl_FragColor = vec4(vec3(0.82, 0.84, 0.88), vAlpha * soft * 0.5);
        }
      `,
    });
    this.smoke = new THREE.Points(sg, sm);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 3;
    scene.add(this.smoke);

    // ---- 胎印 ----
    this.skidPos = new Float32Array(SKID_MAX * 6);
    this.skidAlpha = new Float32Array(SKID_MAX * 2);
    const kg = new THREE.BufferGeometry();
    kg.setAttribute("position", new THREE.BufferAttribute(this.skidPos, 3));
    kg.setAttribute("alpha", new THREE.BufferAttribute(this.skidAlpha, 1));
    const km = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() { gl_FragColor = vec4(0.04, 0.04, 0.05, vAlpha * 0.42); }
      `,
    });
    this.skid = new THREE.LineSegments(kg, km);
    this.skid.frustumCulled = false;
    this.skid.renderOrder = 2;
    scene.add(this.skid);
  }

  /**
   * 每渲染帧调用。只读 physics 的公开查询方法，不做任何写入。
   */
  update(dt: number, physics: VehiclePhysics): void {
    const drifting = physics.isDrifting();
    const speed = Math.abs(physics.speedKmh());
    const active = drifting && speed > MIN_SPEED && physics.contactCount() > 0;

    if (active) {
      const vel = physics.body.linvel();
      // 每 0.025s 发一颗，与帧率解耦，高帧率不会喷成一团
      this.emitAcc += dt;
      const step = 0.025;
      while (this.emitAcc >= step) {
        this.emitAcc -= step;
        for (let i = 0; i < 4; i++) {
          if (!physics.controller.wheelIsInContact(i)) continue;
          // 只有后轮冒烟，前轮抓地不打滑
          if (i < 2) continue;
          this.markAt(i, physics, vel);
        }
      }
    } else {
      this.emitAcc = 0;
      // 断开连线，下次漂移不会跨空隙拉一条直线
      for (let i = 0; i < 4; i++) this.lastMark[i] = null;
    }

    this.stepSmoke(dt);
    this.fadeSkid(dt);
  }

  /** 在第 i 轮触地点补一颗烟 + 一段胎印 */
  private markAt(i: number, physics: VehiclePhysics, vel: { x: number; y: number; z: number }): void {
    // wheelVisual 给的是车身局部坐标，转世界坐标用车根的矩阵
    const s = physics.wheelVisual(i);
    const p = physics.position();
    const q = physics.rotation();
    this.tmp.set(s.localPosition.x, s.localPosition.y - physics.config.wheels.radius, s.localPosition.z);
    this.tmp.applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    this.tmp.set(this.tmp.x + p.x, this.tmp.y + p.y, this.tmp.z + p.z);

    this.spawnSmoke(this.tmp.x, this.tmp.y, this.tmp.z, vel);
    this.pushSkid(i, this.tmp.x, this.tmp.y + 0.02, this.tmp.z);
  }

  private spawnSmoke(x: number, y: number, z: number, vel: { x: number; y: number; z: number }): void {
    const i = this.smokeHead;
    this.smokeHead = (this.smokeHead + 1) % SMOKE_MAX;
    const b = i * 3;
    this.smokePos[b] = x;
    this.smokePos[b + 1] = y + 0.08;
    this.smokePos[b + 2] = z;
    // 继承一点车速再随机扩散，看着像被甩出来的
    this.smokeVel[b] = vel.x * 0.16 + (Math.random() - 0.5) * SMOKE_SPREAD;
    this.smokeVel[b + 1] = SMOKE_RISE * (0.6 + Math.random() * 0.5);
    this.smokeVel[b + 2] = vel.z * 0.16 + (Math.random() - 0.5) * SMOKE_SPREAD;
    this.smokeAge[i] = 0;
  }

  private stepSmoke(dt: number): void {
    for (let i = 0; i < SMOKE_MAX; i++) {
      const age = this.smokeAge[i];
      if (age >= SMOKE_LIFE) {
        this.smokeAlpha[i] = 0;
        continue;
      }
      const na = age + dt;
      this.smokeAge[i] = na;
      const b = i * 3;
      this.smokePos[b] += this.smokeVel[b] * dt;
      this.smokePos[b + 1] += this.smokeVel[b + 1] * dt;
      this.smokePos[b + 2] += this.smokeVel[b + 2] * dt;
      // 空气阻力：横向很快停住，只剩上升
      const drag = Math.pow(0.12, dt);
      this.smokeVel[b] *= drag;
      this.smokeVel[b + 2] *= drag;
      this.smokeVel[b + 1] *= Math.pow(0.5, dt);

      const t = na / SMOKE_LIFE;
      // 快速淡入、缓慢淡出
      this.smokeAlpha[i] = Math.min(1, t * 6) * (1 - t) * (1 - t);
      this.smokeScale[i] = 0.1 + t * 0.42;
    }
    const g = this.smoke.geometry;
    g.getAttribute("position").needsUpdate = true;
    g.getAttribute("alpha").needsUpdate = true;
    g.getAttribute("pscale").needsUpdate = true;
  }

  private pushSkid(wheel: number, x: number, y: number, z: number): void {
    const prev = this.lastMark[wheel];
    if (!prev) {
      this.lastMark[wheel] = new THREE.Vector3(x, y, z);
      return;
    }
    // 移动太小不铺新段，避免慢速原地打转把缓冲刷空
    if (prev.distanceToSquared(this.tmp) < 0.0016) return;

    const i = this.skidHead;
    this.skidHead = (this.skidHead + 1) % SKID_MAX;
    const b = i * 6;
    this.skidPos[b] = prev.x;
    this.skidPos[b + 1] = prev.y;
    this.skidPos[b + 2] = prev.z;
    this.skidPos[b + 3] = x;
    this.skidPos[b + 4] = y;
    this.skidPos[b + 5] = z;
    this.skidAlpha[i * 2] = 1;
    this.skidAlpha[i * 2 + 1] = 1;
    prev.set(x, y, z);

    this.skid.geometry.getAttribute("position").needsUpdate = true;
  }

  /** 胎印缓慢淡出，不用逐段计时，整体线性衰减即可 */
  private fadeSkid(dt: number): void {
    const d = dt * 0.055;
    let dirty = false;
    for (let i = 0; i < this.skidAlpha.length; i++) {
      if (this.skidAlpha[i] > 0) {
        this.skidAlpha[i] = Math.max(0, this.skidAlpha[i] - d);
        dirty = true;
      }
    }
    if (dirty) this.skid.geometry.getAttribute("alpha").needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.smoke);
    this.scene.remove(this.skid);
    this.smoke.geometry.dispose();
    (this.smoke.material as THREE.Material).dispose();
    this.skid.geometry.dispose();
    (this.skid.material as THREE.Material).dispose();
  }
}
