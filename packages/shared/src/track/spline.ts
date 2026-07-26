import type { Vec3Like } from "../types";

export interface SplineSample {
  position: Vec3Like;
  /** 单位切向量（行进方向） */
  tangent: Vec3Like;
  /** 距起点累计弧长 (m) */
  distance: number;
}

export interface SampledSpline {
  samples: SplineSample[];
  /** 闭环总长 (m) */
  totalLength: number;
}

/** Catmull-Rom 单轴插值 */
function cr(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
}

/**
 * 闭环 Catmull-Rom 样条采样：
 * 先按每段细分密集采样，再按近似等弧长重采样。
 * 返回的采样点不重复首点（首尾自动闭合）。
 */
export function sampleClosedSpline(
  controlPoints: [number, number, number][],
  spacing = 2
): SampledSpline {
  const n = controlPoints.length;
  if (n < 4) throw new Error("闭环样条至少需要 4 个控制点");
  const pts: Vec3Like[] = controlPoints.map(([x, y, z]) => ({ x, y, z }));

  // 1) 密集采样
  const SUBDIV = 32;
  const dense: { p: Vec3Like; d: number }[] = [];
  let acc = 0;
  let prev: Vec3Like | null = null;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let k = 0; k < SUBDIV; k++) {
      const t = k / SUBDIV;
      const p: Vec3Like = {
        x: cr(p0.x, p1.x, p2.x, p3.x, t),
        y: cr(p0.y, p1.y, p2.y, p3.y, t),
        z: cr(p0.z, p1.z, p2.z, p3.z, t),
      };
      if (prev) acc += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      dense.push({ p, d: acc });
      prev = p;
    }
  }
  // 闭合段长度
  const first = dense[0].p;
  const last = dense[dense.length - 1].p;
  const totalLength = acc + Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z);

  // 2) 等弧长重采样
  const count = Math.max(16, Math.round(totalLength / spacing));
  const positions: Vec3Like[] = [];
  let cursor = 0;
  for (let s = 0; s < count; s++) {
    const target = (s * totalLength) / count;
    while (cursor < dense.length - 1 && dense[cursor + 1].d < target) cursor++;
    const a = dense[cursor];
    const b = dense[(cursor + 1) % dense.length];
    const bd = cursor + 1 < dense.length ? b.d : totalLength;
    const span = Math.max(1e-6, bd - a.d);
    const t = Math.min(1, Math.max(0, (target - a.d) / span));
    positions.push({
      x: a.p.x + (b.p.x - a.p.x) * t,
      y: a.p.y + (b.p.y - a.p.y) * t,
      z: a.p.z + (b.p.z - a.p.z) * t,
    });
  }

  // 3) 切向量：中心差分
  const samples: SplineSample[] = positions.map((p, i) => {
    const prev2 = positions[(i - 1 + count) % count];
    const next2 = positions[(i + 1) % count];
    const tx = next2.x - prev2.x;
    const ty = next2.y - prev2.y;
    const tz = next2.z - prev2.z;
    const len = Math.hypot(tx, ty, tz) || 1;
    return {
      position: p,
      tangent: { x: tx / len, y: ty / len, z: tz / len },
      distance: (i * totalLength) / count,
    };
  });

  return { samples, totalLength };
}

/**
 * 开放（非闭环）Catmull-Rom 采样：用于不闭合的路径。
 * 端点通过镜像外推得到虚拟控制点，保证首尾切向自然。
 */
export function sampleOpenSpline(
  controlPoints: [number, number, number][],
  spacing = 2
): SampledSpline {
  const n = controlPoints.length;
  if (n < 2) throw new Error("开放样条至少需要 2 个控制点");
  const pts: Vec3Like[] = controlPoints.map(([x, y, z]) => ({ x, y, z }));
  // 镜像外推首尾虚拟点
  const ext: Vec3Like[] = [
    { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y, z: 2 * pts[0].z - pts[1].z },
    ...pts,
    {
      x: 2 * pts[n - 1].x - pts[n - 2].x,
      y: 2 * pts[n - 1].y - pts[n - 2].y,
      z: 2 * pts[n - 1].z - pts[n - 2].z,
    },
  ];

  const SUBDIV = 32;
  const dense: { p: Vec3Like; d: number }[] = [];
  let acc = 0;
  let prev: Vec3Like | null = null;
  // 段 i 连接 ext[i+1] → ext[i+2]
  for (let i = 0; i < n - 1; i++) {
    const p0 = ext[i];
    const p1 = ext[i + 1];
    const p2 = ext[i + 2];
    const p3 = ext[i + 3];
    const steps = i === n - 2 ? SUBDIV + 1 : SUBDIV; // 末段含终点
    for (let k = 0; k < steps; k++) {
      const t = k / SUBDIV;
      const p: Vec3Like = {
        x: cr(p0.x, p1.x, p2.x, p3.x, t),
        y: cr(p0.y, p1.y, p2.y, p3.y, t),
        z: cr(p0.z, p1.z, p2.z, p3.z, t),
      };
      if (prev) acc += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
      dense.push({ p, d: acc });
      prev = p;
    }
  }
  const totalLength = acc;

  const count = Math.max(4, Math.round(totalLength / spacing));
  const positions: Vec3Like[] = [];
  let cursor = 0;
  for (let s = 0; s <= count; s++) {
    const target = (s * totalLength) / count;
    while (cursor < dense.length - 1 && dense[cursor + 1].d < target) cursor++;
    const a = dense[cursor];
    const b = dense[Math.min(cursor + 1, dense.length - 1)];
    const span = Math.max(1e-6, b.d - a.d);
    const t = Math.min(1, Math.max(0, (target - a.d) / span));
    positions.push({
      x: a.p.x + (b.p.x - a.p.x) * t,
      y: a.p.y + (b.p.y - a.p.y) * t,
      z: a.p.z + (b.p.z - a.p.z) * t,
    });
  }

  const m = positions.length;
  const samples: SplineSample[] = positions.map((p, i) => {
    const prev2 = positions[Math.max(0, i - 1)];
    const next2 = positions[Math.min(m - 1, i + 1)];
    const tx = next2.x - prev2.x;
    const ty = next2.y - prev2.y;
    const tz = next2.z - prev2.z;
    const len = Math.hypot(tx, ty, tz) || 1;
    return {
      position: p,
      tangent: { x: tx / len, y: ty / len, z: tz / len },
      distance: (i * totalLength) / count,
    };
  });

  return { samples, totalLength };
}

/**
 * 各采样点的水平转向曲率 (rad/m)，正=左转负=右转。
 * 用于识别发卡弯（|κ| 大）与标定漂移收益。
 */
export function curvatures(samples: SplineSample[], closed = true): number[] {
  const n = samples.length;
  return samples.map((s, i) => {
    const j = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    if (j === i) return 0;
    const b = samples[j];
    let dYaw = yawOf(b.tangent) - yawOf(s.tangent);
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const ds = Math.abs(b.distance - s.distance) || 1e-6;
    return dYaw / ds;
  });
}

/** 样条某采样点的左侧方向（水平面内，垂直于切向） */
export function leftOf(tangent: Vec3Like): Vec3Like {
  // left = up × tangent（up = +Y）
  const x = tangent.z;
  const z = -tangent.x;
  const len = Math.hypot(x, z) || 1;
  return { x: x / len, y: 0, z: z / len };
}

/** 由切向量得到偏航角（车头 +Z 约定） */
export function yawOf(tangent: Vec3Like): number {
  return Math.atan2(tangent.x, tangent.z);
}
