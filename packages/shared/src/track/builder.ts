import type {
  DistWindow,
  RampSpec,
  SidedWindow,
  TrackConfig,
  Vec3Like,
  WidthZone,
} from "../types";

export type { SidedWindow };
import { leftOf, yawOf, type SplineSample } from "./spline";

/** 带状网格数据（可直接喂给 three BufferGeometry 或 Rapier trimesh） */
export interface RibbonGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface RibbonOptions {
  /** 闭环（默认 true） */
  closed?: boolean;
  /** 纹理 V 方向缩放 */
  vScale?: number;
  /** 抬升高度（防 z-fighting） */
  yLift?: number;
  /** 跳过这些弧长窗口内的面片（飞跃断口） */
  skipWindows?: DistWindow[];
  /** 局部加宽区：横向偏移按倍数缩放 */
  widthZones?: WidthZone[];
  /** 飞坡抬升 */
  ramps?: RampSpec[];
  /**
   * 不随加宽缩放的固定偏移量 (m)，带符号直接叠加在缩放后的偏移上。
   * 路缘用它：路面变宽时路缘随之外移，但路缘本身不变粗。
   * 例：左路缘 = (base +hw, pad +0.85) → (base +hw, pad 0)。
   */
  leftPad?: number;
  rightPad?: number;
}

export function inWindows(d: number, windows?: DistWindow[]): boolean {
  if (!windows) return false;
  for (const w of windows) if (d >= w.fromDist && d <= w.toDist) return true;
  return false;
}

/** 平滑阶跃 0→1（两端一阶导为 0，避免路宽突变） */
function smoothStep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * 某弧长处的宽度倍数：加宽区内为 scale，两端 blend 米内平滑过渡。
 * 多个区重叠时取最大值（更宽的赢），保证过渡连续。
 */
export function widthScaleAt(d: number, zones?: WidthZone[]): number {
  if (!zones?.length) return 1;
  let scale = 1;
  for (const z of zones) {
    const blend = Math.max(1e-3, z.blend ?? 25);
    let f: number;
    if (d >= z.fromDist && d <= z.toDist) f = 1;
    else if (d > z.fromDist - blend && d < z.fromDist) f = smoothStep((d - (z.fromDist - blend)) / blend);
    else if (d > z.toDist && d < z.toDist + blend) f = smoothStep((z.toDist + blend - d) / blend);
    else continue;
    scale = Math.max(scale, 1 + (z.scale - 1) * f);
  }
  return scale;
}

/**
 * 飞坡在某弧长处的抬升高度 (m)。
 * 上坡用平滑曲线（车贴着走不会弹飞），坡顶之后按 landing 长度线性回落；
 * landing = 0 即坡顶直接截断，成为纯跳台。
 */
export function rampLiftAt(d: number, ramps?: RampSpec[]): number {
  if (!ramps?.length) return 0;
  let lift = 0;
  for (const r of ramps) {
    if (d >= r.fromDist && d <= r.peakDist) {
      const span = Math.max(1e-3, r.peakDist - r.fromDist);
      lift = Math.max(lift, r.height * smoothStep((d - r.fromDist) / span));
    } else if (r.landing > 0 && d > r.peakDist && d <= r.peakDist + r.landing) {
      const f = (d - r.peakDist) / r.landing;
      lift = Math.max(lift, r.height * (1 - smoothStep(f)));
    }
  }
  return lift;
}



/**
 * 沿样条生成带状网格。
 * leftOffset/rightOffset 为基准横向偏移（左正右负），会按 widthZones 缩放，
 * 例：路面 = (+w/2, -w/2)；左路缘 = (+w/2+0.85, +w/2)。
 */
export function buildRibbonGeometry(
  samples: SplineSample[],
  leftOffset: number,
  rightOffset: number,
  opts: RibbonOptions = {}
): RibbonGeometry {
  const { closed = true, vScale = 8, yLift = 0, skipWindows, widthZones, ramps, leftPad = 0, rightPad = 0 } = opts;
  const n = samples.length;
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);

  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const side = leftOf(s.tangent);
    const ws = widthScaleAt(s.distance, widthZones);
    const rl = rampLiftAt(s.distance, ramps);
    const lOff = leftOffset * ws + leftPad;
    const rOff = rightOffset * ws + rightPad;
    positions[i * 6 + 0] = s.position.x + side.x * lOff;
    positions[i * 6 + 1] = s.position.y + yLift + rl;
    positions[i * 6 + 2] = s.position.z + side.z * lOff;
    positions[i * 6 + 3] = s.position.x + side.x * rOff;
    positions[i * 6 + 4] = s.position.y + yLift + rl;
    positions[i * 6 + 5] = s.position.z + side.z * rOff;
    const v = s.distance / vScale;
    uvs[i * 4 + 0] = 0;
    uvs[i * 4 + 1] = v;
    uvs[i * 4 + 2] = 1;
    uvs[i * 4 + 3] = v;
  }

  const quadCount = closed ? n : n - 1;
  const idx: number[] = [];
  for (let i = 0; i < quadCount; i++) {
    const j = (i + 1) % n;
    // 断口：该面片起点落在窗口内则跳过
    if (inWindows(samples[i].distance, skipWindows)) continue;
    const v0 = i * 2;
    const v1 = i * 2 + 1;
    const v2 = j * 2;
    const v3 = j * 2 + 1;
    // 法线朝上的绕序
    idx.push(v0, v1, v2, v1, v3, v2);
  }

  return { positions, uvs, indices: new Uint32Array(idx) };
}

/** 护栏分段（薄长方体，客户端渲染 + Rapier cuboid 碰撞体共用） */
export interface WallSegment {
  /** 段中心（y 为路面高度，不含护栏半高） */
  center: Vec3Like;
  yaw: number;
  halfLength: number;
}

export interface WallOptions {
  closed?: boolean;
  /**
   * 跳过窗口（飞跃断口等）。
   * 带 side 的窗口只作用于该侧护栏。
   */
  skipWindows?: SidedWindow[];
  /** 本路的加宽区：护栏随路面外扩 */
  widthZones?: WidthZone[];
  /** 本路的飞坡：护栏随坡面抬升 */
  ramps?: RampSpec[];
  /**
   * 不随加宽缩放的固定外移量 (m)，符号与 sideOffset 一致。
   * 路缘+余量属于固定尺寸，若一起缩放，加宽段的护栏会离路缘越来越远。
   */
  pad?: number;
}

/** 沿样条一侧生成护栏分段；sideOffset 左正右负 */
export function buildWallSegments(
  samples: SplineSample[],
  sideOffset: number,
  opts: WallOptions = {}
): WallSegment[] {
  const { closed = true, skipWindows, widthZones, ramps, pad = 0 } = opts;
  const n = samples.length;
  const segs: WallSegment[] = [];
  const count = closed ? n : n - 1;
  // 本侧护栏的侧向由 sideOffset 符号直接确定（左正右负），无需从几何反推
  const thisSide: "left" | "right" = sideOffset >= 0 ? "left" : "right";
  for (let i = 0; i < count; i++) {
    const d0 = samples[i].distance;
    if (skipWindows?.some((w) => (!w.side || w.side === thisSide) && d0 >= w.fromDist && d0 <= w.toDist)) continue;
    const a = samples[i];
    const b = samples[(i + 1) % n];
    const sa = leftOf(a.tangent);
    const sb = leftOf(b.tangent);
    const oa = sideOffset * widthScaleAt(a.distance, widthZones) + pad;
    const ob = sideOffset * widthScaleAt(b.distance, widthZones) + pad;
    const ax = a.position.x + sa.x * oa;
    const az = a.position.z + sa.z * oa;
    const bx = b.position.x + sb.x * ob;
    const bz = b.position.z + sb.z * ob;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const center = {
      x: (ax + bx) / 2,
      y:
        (a.position.y + b.position.y) / 2 +
        (rampLiftAt(a.distance, ramps) + rampLiftAt(b.distance, ramps)) / 2,
      z: (az + bz) / 2,
    };
    segs.push({
      center,
      yaw: Math.atan2(dx, dz),
      halfLength: len / 2 + 0.15, // 轻微重叠防缝隙
    });
  }
  return segs;
}

/** 检查点：有序通过计圈，也是重生点 */
export interface Checkpoint {
  index: number;
  position: Vec3Like;
  /** 行进方向（判定正向通过 + 重生朝向） */
  forward: Vec3Like;
  yaw: number;
}

/**
 * 沿样条每隔 everyMeters 放一个检查点；index 0 = 起点/终点线。
 * excludeWindows 内不放（断口上方是空的，检查点会落到虚空里）。
 */
export function buildCheckpoints(
  samples: SplineSample[],
  everyMeters: number,
  totalLength: number,
  excludeWindows?: DistWindow[]
): Checkpoint[] {
  const cps: Checkpoint[] = [];
  let nextAt = 0;
  let lastDist = 0;
  for (const s of samples) {
    if (s.distance >= nextAt) {
      if (inWindows(s.distance, excludeWindows)) continue; // 出窗后立刻补放
      cps.push({
        index: cps.length,
        position: s.position,
        forward: s.tangent,
        yaw: yawOf(s.tangent),
      });
      lastDist = s.distance;
      nextAt = s.distance + everyMeters;
    }
  }
  // 最后一个检查点若离终点线（闭环处）太近则丢弃，保证间距
  if (cps.length > 2 && totalLength - lastDist < everyMeters * 0.5) cps.pop();
  return cps;
}

/**
 * 检查点排除窗口：飞跃断口附近（含缓冲）。
 * 断口上方没有路面，检查点落在那里等于悬在空中，且坠落重生会把车送回虚空。
 * 服务端与客户端必须用同一份，保证裁判一致。
 */
export function trackExclusionWindows(track: TrackConfig): DistWindow[] {
  const w: DistWindow[] = [];
  for (const g of track.gaps ?? []) {
    w.push({ fromDist: g.fromDist - 30, toDist: g.toDist + 25 });
  }
  // 赛道设计显式指定的排除段（见 TrackConfig.checkpointExclusions）
  for (const e of track.checkpointExclusions ?? []) {
    w.push({ fromDist: e.fromDist, toDist: e.toDist });
  }
  return w;
}

/** 判定"已坠落"的下沉高度：车低于路面这么多米即算掉出赛道 */
export const FALL_DEPTH = 4;

/**
 * 是否已坠出赛道（用于传送回最近检查点）。
 *
 * 判据是"相对路面下沉"而不是绝对 y：赛道本身有 0.5~6.1m 的高差，
 * 写死一个 y 阈值会让低处路段误判、高处桥面漏判。
 * 取水平最近的中心线采样点作参照，赛道无立体交叉时这个参照唯一。
 *
 * 腾空飞越断口时车高于桥面，不会触发；掉进断口则一路下沉直到超过阈值。
 */
export function hasFallenOff(pos: Vec3Like, samples: SplineSample[], fallDepth = FALL_DEPTH): boolean {
  if (samples.length === 0) return false;
  let bestSq = Infinity;
  let refY = samples[0].position.y;
  for (const s of samples) {
    const dx = pos.x - s.position.x;
    const dz = pos.z - s.position.z;
    const dsq = dx * dx + dz * dz;
    if (dsq < bestSq) {
      bestSq = dsq;
      refY = s.position.y;
    }
  }
  return pos.y < refY - fallDepth;
}
