import canyon from "./packages/shared/src/data/tracks/canyon.json" with { type: "json" };
import { sampleClosedSpline } from "./packages/shared/src/track/spline.js";
import { rampLiftAt } from "./packages/shared/src/track/builder.js";

const t: any = canyon;
const main = sampleClosedSpline(t.controlPoints, 2);
const at = (d: number) => {
  let best = main.samples[0];
  for (const s of main.samples) if (Math.abs(s.distance - d) < Math.abs(best.distance - d)) best = s;
  return best;
};
console.log("主路 fork→rejoin 区间走向 (含飞坡抬升):");
for (let d = 30; d <= 340; d += 20) {
  const s = at(d);
  const lift = rampLiftAt(s.distance, t.ramps);
  const sx = -s.tangent.z, sz = s.tangent.x;
  console.log(
    `  ${String(d).padStart(3)}m  x=${s.position.x.toFixed(1).padStart(7)}  y=${(s.position.y + lift).toFixed(2).padStart(5)}  z=${s.position.z.toFixed(1).padStart(7)}` +
    `   右法向=(${(-sx).toFixed(2)}, ${(-sz).toFixed(2)})`
  );
}
console.log("\n断口两端桥唇:");
for (const d of [206, 208, 226, 228]) {
  const s = at(d);
  console.log(`  ${d}m x=${s.position.x.toFixed(2)} y=${(s.position.y + rampLiftAt(s.distance, t.ramps)).toFixed(2)} z=${s.position.z.toFixed(2)}`);
}
const f = at(48), r = at(316);
console.log(`\nfork@48m  (${f.position.x.toFixed(2)}, ${f.position.y.toFixed(2)}, ${f.position.z.toFixed(2)})`);
console.log(`rejoin@316m (${r.position.x.toFixed(2)}, ${r.position.y.toFixed(2)}, ${r.position.z.toFixed(2)})`);
const rf = { x: f.tangent.z, z: -f.tangent.x };
const rr = { x: r.tangent.z, z: -r.tangent.x };
console.log(`fork 右法向 (${rf.x.toFixed(3)}, ${rf.z.toFixed(3)})   rejoin 右法向 (${rr.x.toFixed(3)}, ${rr.z.toFixed(3)})`);
