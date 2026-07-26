/**
 * 赛道几何探针：打印各图长度、发卡弯（|κ| 大）位置、
 * 以及指定世界坐标在主环上的最近弧长——用于标定 gaps 窗口。
 * 运行: pnpm probe
 */
import { TRACKS } from "../src/data/tracks";
import { sampleClosedSpline, curvatures, leftOf } from "../src/track/spline";
import type { SplineSample } from "../src/track/spline";

function nearestDist(samples: SplineSample[], x: number, z: number) {
  let best = { d: 0, dist: Infinity, lateral: 0 };
  for (const s of samples) {
    const dx = x - s.position.x;
    const dz = z - s.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < best.dist) {
      const side = leftOf(s.tangent);
      best = { d: s.distance, dist, lateral: dx * side.x + dz * side.z };
    }
  }
  return best;
}

for (const t of Object.values(TRACKS)) {
  const { samples, totalLength } = sampleClosedSpline(t.controlPoints, 2);
  console.log(`\n=== ${t.id} ${t.name} ===`);
  console.log(`主环长度 ${totalLength.toFixed(1)}m · 路宽 ${t.roadWidth}m · ${t.laps}圈`);

  const k = curvatures(samples, true);
  // 发卡弯：连续同向且累计转角 > 150°
  const hairpins: { dist: number; deg: number; radius: number }[] = [];
  let i = 0;
  while (i < k.length) {
    if (Math.abs(k[i]) < 0.012) {
      i++;
      continue;
    }
    const sign = Math.sign(k[i]);
    let acc = 0;
    let maxAbs = 0;
    const start = i;
    while (i < k.length && Math.sign(k[i]) === sign && Math.abs(k[i]) > 0.008) {
      const ds = 2;
      acc += k[i] * ds;
      maxAbs = Math.max(maxAbs, Math.abs(k[i]));
      i++;
    }
    const deg = Math.abs((acc * 180) / Math.PI);
    if (deg > 150) {
      hairpins.push({
        dist: samples[start].distance,
        deg,
        radius: maxAbs > 0 ? 1 / maxAbs : Infinity,
      });
    }
  }
  if (hairpins.length) {
    for (const h of hairpins) {
      console.log(
        `  发卡弯 @${h.dist.toFixed(0)}m  转角 ${h.deg.toFixed(0)}°  最小半径 ${h.radius.toFixed(1)}m`
      );
    }
  } else {
    console.log("  无发卡弯 (>150°)");
  }

  const yMin = Math.min(...samples.map((s) => s.position.y));
  const yMax = Math.max(...samples.map((s) => s.position.y));
  console.log(`  高度范围 ${yMin.toFixed(1)} ~ ${yMax.toFixed(1)}m`);

  // 有 gaps 的图：打印控制点弧长表（用于标定窗口）
  if (t.gaps?.length) {
    const rows = t.controlPoints.map((cp, i) => {
      const n = nearestDist(samples, cp[0], cp[2]);
      return `#${i}(${cp[0]},${cp[2]})@${n.d.toFixed(0)}m`;
    });
    console.log(`  CP弧长: ${rows.join(" ")}`);
  }

}

// 与其他图对比长度
const lens = Object.values(TRACKS).map((t) => ({
  id: t.id,
  len: sampleClosedSpline(t.controlPoints, 2).totalLength,
}));
const base = Math.max(...lens.filter((l) => l.id !== "canyon").map((l) => l.len));
const canyon = lens.find((l) => l.id === "canyon");
if (canyon) {
  console.log(
    `\n峡谷 ${canyon.len.toFixed(0)}m vs 最长旧图 ${base.toFixed(0)}m = ${((canyon.len / base - 1) * 100).toFixed(0)}% 更长`
  );
}
