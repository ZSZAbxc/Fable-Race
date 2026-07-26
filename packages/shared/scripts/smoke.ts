/**
 * 无头物理冒烟测试：在 Node 中跑 Rapier 载具模拟，
 * 验证坐标约定（+Z 前进）、转向方向（steer +1 = 左转 = yaw 增大）与刹车。
 * 运行: pnpm smoke
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { PHYSICS_DT, GRAVITY_Y } from "../src/constants";
import { CARS } from "../src/data/cars";
import { TRACKS } from "../src/data/tracks";
import { VehiclePhysics, upFromQuat, forwardFromQuat } from "../src/vehicle/VehiclePhysics";
import { sampleClosedSpline, curvatures, yawOf } from "../src/track/spline";
import {
  buildRibbonGeometry,
  buildWallSegments,
  buildCheckpoints,
  trackExclusionWindows,
  hasFallenOff,
  widthScaleAt,
  inWindows,
} from "../src/track/builder";
import { RaceProgress } from "../src/race/RaceProgress";
import type { VehicleInput } from "../src/types";

function step(world: RAPIER.World, car: VehiclePhysics, input: Partial<VehicleInput>, seconds: number) {
  const full: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, ...input };
  const n = Math.round(seconds / PHYSICS_DT);
  for (let i = 0; i < n; i++) {
    car.update(full, PHYSICS_DT);
    world.step();
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  if (!ok) failures++;
}

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
world.timestep = PHYSICS_DT;

// 大地面
world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0));

const car = new VehiclePhysics(world, CARS.falcon, { position: { x: 0, y: 1.2, z: 0 }, yaw: 0 });

// 1) 静置沉降：不应下陷或弹飞
step(world, car, {}, 1.5);
const rest = car.position();
check("悬挂静置", rest.y > 0.3 && rest.y < 1.5, `y=${rest.y.toFixed(2)}`);

// 2) 全油门 3 秒：应沿 +Z 明显前进、横向漂移小
const p0 = car.position();
step(world, car, { throttle: 1 }, 3);
const p1 = car.position();
const dz = p1.z - p0.z;
const dx = p1.x - p0.x;
check("油门 = +Z 前进", dz > 20, `dz=${dz.toFixed(1)}m dx=${dx.toFixed(2)}m`);
check("直线行驶不跑偏", Math.abs(dx) < 2, `dx=${dx.toFixed(2)}m`);
check("速度合理", car.speedKmh() > 40 && car.speedKmh() < 200, `${car.speedKmh().toFixed(0)} km/h`);

// 3) 刹车：应明显减速
const vBefore = car.speedKmh();
step(world, car, { brake: 1 }, 2);
const vAfter = car.speedKmh();
check("刹车减速", vAfter < vBefore * 0.35, `${vBefore.toFixed(0)} -> ${vAfter.toFixed(0)} km/h`);

// 4) 转向：油门 + 左转 → yaw 增大（逆时针）
car.reset();
step(world, car, {}, 0.5);
step(world, car, { throttle: 0.6 }, 1.2); // 先起步
const yaw0 = car.yaw();
step(world, car, { throttle: 0.6, steer: 1 }, 1.5);
const yaw1 = car.yaw();
let dyaw = yaw1 - yaw0;
while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
check("steer=+1 → 左转 (yaw+)", dyaw > 0.3, `Δyaw=${dyaw.toFixed(2)} rad`);

// 5) 倒车：静止按刹车 → 沿 -Z 后退
car.reset();
step(world, car, {}, 0.5);
const r0 = car.position();
step(world, car, { brake: 1 }, 2);
const r1 = car.position();
check("倒车 = -Z 后退", r1.z - r0.z < -1, `dz=${(r1.z - r0.z).toFixed(1)}m`);

// 6) 复位
car.reset();
const rp = car.position();
check("复位到出生点", Math.abs(rp.x) < 0.01 && Math.abs(rp.z) < 0.01, `(${rp.x.toFixed(2)}, ${rp.z.toFixed(2)})`);

// 7) 滑行减速：加速到高速后松开所有键，应逐渐减速到接近停止
car.reset();
step(world, car, {}, 0.5);
step(world, car, { throttle: 1 }, 3);
const coastStart = car.speedKmh();
step(world, car, {}, 6); // 纯滑行
const coastMid = car.speedKmh();
step(world, car, {}, 10);
const coastEnd = car.speedKmh();
check("松油门逐渐减速", coastMid < coastStart * 0.7, `${coastStart.toFixed(0)} -> ${coastMid.toFixed(0)} km/h (6s)`);
check("滑行最终接近停止", coastEnd < 5, `16s 后 ${coastEnd.toFixed(1)} km/h`);

// 8) 翻车自动复位：把车倒扣，2 秒后应自动扶正
car.reset();
step(world, car, {}, 0.5);
const flipPos = car.position();
car.body.setTranslation({ x: flipPos.x, y: 1.2, z: flipPos.z }, true);
car.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true); // 绕 X 转 180° = 四轮朝天
car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
step(world, car, {}, 1.0); // 落地停稳
check("倒扣判定为翻车", car.isFlipped(), `upY<0.15`);
step(world, car, {}, 3.5); // 等待自动复位 + 落地
const uprightY = upFromQuat(car.rotation()).y;
check("2 秒后自动扶正", uprightY > 0.9, `upY=${uprightY.toFixed(2)}`);
const keepPos = car.position();
const drift = Math.hypot(keepPos.x - flipPos.x, keepPos.z - flipPos.z);
check("原地复位（位置不变）", drift < 1.5, `偏移 ${drift.toFixed(2)}m`);

// 9) 影视漂移：按住空格+转向 → 车头甩动而速度方向基本保持；松开恢复抓地
function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
car.reset();
step(world, car, {}, 0.5);
step(world, car, { throttle: 1 }, 3); // ~90 km/h 直行
const dv0 = car.body.linvel();
const velDir0 = Math.atan2(dv0.x, dv0.z);
const entrySpeed = Math.hypot(dv0.x, dv0.z);
const yawD0 = car.yaw();
step(world, car, { handbrake: true, steer: 1 }, 0.8); // 漂移中
const dv1 = car.body.linvel();
const velDir1 = Math.atan2(dv1.x, dv1.z);
const driftSpeed = Math.hypot(dv1.x, dv1.z);
const yawD1 = car.yaw();
const dVel = Math.abs(normAngle(velDir1 - velDir0));
const dYaw = Math.abs(normAngle(yawD1 - yawD0));
check("漂移：车头明显甩动", dYaw > 0.35, `Δyaw=${dYaw.toFixed(2)} rad`);
check("漂移：速度方向基本保持", dVel < dYaw * 0.55, `Δvel=${dVel.toFixed(2)} vs Δyaw=${dYaw.toFixed(2)}`);
check("漂移：车速基本保持", driftSpeed > entrySpeed * 0.55, `${(entrySpeed * 3.6).toFixed(0)} -> ${(driftSpeed * 3.6).toFixed(0)} km/h`);
// 松开空格恢复抓地：滑移角收敛
step(world, car, { throttle: 1 }, 1.6);
const dv2 = car.body.linvel();
const fw = forwardFromQuat(car.rotation());
const slip = Math.abs(normAngle(Math.atan2(dv2.x, dv2.z) - Math.atan2(fw.x, fw.z)));
const upAfterDrift = upFromQuat(car.rotation()).y;
check("松开手刹恢复抓地", slip < 0.3 && upAfterDrift > 0.85, `滑移角 ${slip.toFixed(2)} rad, upY=${upAfterDrift.toFixed(2)}`);

// ================= 赛道管线 =================

// 9) 每张赛道：样条闭合、长度、检查点数量与间距
for (const track of Object.values(TRACKS)) {
  const { samples, totalLength } = sampleClosedSpline(track.controlPoints, 2);
  const s0 = samples[0].position;
  const sN = samples[samples.length - 1].position;
  const closeGap = Math.hypot(s0.x - sN.x, s0.y - sN.y, s0.z - sN.z);
  check(`[${track.id}] 样条闭合`, closeGap < 6, `首尾间距 ${closeGap.toFixed(1)}m, 总长 ${totalLength.toFixed(0)}m`);
  check(`[${track.id}] 赛道长度合理`, totalLength > 250 && totalLength < 4000, `${totalLength.toFixed(0)}m`);

  const exclusions = trackExclusionWindows(track);
  const cps = buildCheckpoints(samples, track.checkpointEvery, totalLength, exclusions);
  let minGap = Infinity;
  for (let i = 0; i < cps.length; i++) {
    const a = cps[i].position;
    const b = cps[(i + 1) % cps.length].position;
    minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.z - b.z));
  }
  const cpInWindow = cps.some((cp) => inWindows(samplesDistOf(samples, cp.position), exclusions));
  check(
    `[${track.id}] 检查点`,
    cps.length >= 6 && minGap > track.roadWidth && !cpInWindow,
    `${cps.length} 个，最小间距 ${minGap.toFixed(0)}m，避开断口/岔区=${!cpInWindow}`
  );

  // 几何数据无 NaN；有断口的图允许缺少若干面片
  const road = buildRibbonGeometry(samples, track.roadWidth / 2 + 0.85, -track.roadWidth / 2 - 0.85, {
    skipWindows: track.gaps,
    widthZones: track.widthZones,
    ramps: track.ramps,
  });
  const hasNaN = road.positions.some((v) => !Number.isFinite(v));
  const fullQuads = samples.length * 6;
  const okQuads = track.gaps?.length
    ? road.indices.length < fullQuads && road.indices.length > fullQuads - 60 * 6
    : road.indices.length === fullQuads;
  check(`[${track.id}] 路面几何`, !hasNaN && okQuads, `${road.positions.length / 3} 顶点, ${road.indices.length / 6} 面片`);
}

/** 找到某位置在样条上的近似弧长 */
function samplesDistOf(samples: ReturnType<typeof sampleClosedSpline>["samples"], pos: { x: number; z: number }): number {
  let best = samples[0];
  let bd = Infinity;
  for (const s of samples) {
    const d = Math.hypot(s.position.x - pos.x, s.position.z - pos.z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best.distance;
}

// 10) 可驾驶性：sunrise 赛道 trimesh + 护栏，实车行驶验证
{
  const track = TRACKS.sunrise;
  const w2 = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
  w2.timestep = PHYSICS_DT;
  const { samples, totalLength } = sampleClosedSpline(track.controlPoints, 2);
  // 草地兜底
  w2.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.55, 0));
  // 路面 trimesh（含路缘宽度）
  const road = buildRibbonGeometry(samples, track.roadWidth / 2 + 0.85, -track.roadWidth / 2 - 0.85, {
    widthZones: track.widthZones,
    ramps: track.ramps,
  });
  w2.createCollider(RAPIER.ColliderDesc.trimesh(road.positions, road.indices).setFriction(1.0));
  // 护栏
  const off = track.roadWidth / 2 + 1.1;
  for (const side of [off, -off]) {
    for (const seg of buildWallSegments(samples, side)) {
      w2.createCollider(
        RAPIER.ColliderDesc.cuboid(0.15, track.wallHeight / 2, seg.halfLength)
          .setTranslation(seg.center.x, seg.center.y + track.wallHeight / 2, seg.center.z)
          .setRotation({ x: 0, y: Math.sin(seg.yaw / 2), z: 0, w: Math.cos(seg.yaw / 2) })
      );
    }
  }
  // 出生点：起点线后方 12m
  const t0 = samples[0].tangent;
  const spawn = {
    position: {
      x: samples[0].position.x - t0.x * 12,
      y: samples[0].position.y + 0.8,
      z: samples[0].position.z - t0.z * 12,
    },
    yaw: yawOf(t0),
  };
  const car2 = new VehiclePhysics(w2, CARS.falcon, spawn);
  step(w2, car2, {}, 1.2);
  const restY = car2.position().y;
  const expectY = samples[0].position.y + 0.74;
  check("赛道出生点落在路面上", Math.abs(restY - expectY) < 0.35, `y=${restY.toFixed(2)} 期望≈${expectY.toFixed(2)}`);
  step(w2, car2, { throttle: 1 }, 3);
  const drivePos = car2.position();
  const driveOk = car2.speedKmh() > 30 && Number.isFinite(drivePos.x) && drivePos.y > -0.5;
  check("赛道路面可驾驶", driveOk, `3s 后 ${car2.speedKmh().toFixed(0)} km/h, y=${drivePos.y.toFixed(2)}`);

  // 11) 计圈逻辑：沿检查点序列模拟两圈
  const cps = buildCheckpoints(samples, track.checkpointEvery, totalLength);
  const rp = new RaceProgress(cps, 2, track.roadWidth);
  let t = 0;
  const events: string[] = [];
  for (let loop = 0; loop < 2; loop++) {
    for (const cp of cps) {
      t += 5000;
      const vel = { x: cp.forward.x * 15, y: 0, z: cp.forward.z * 15 };
      const ev = rp.update(cp.position, vel, t);
      if (ev.started) events.push("start");
      if (ev.lapCompleted) events.push(`lap${ev.lapCompleted}`);
      if (ev.finished) events.push("finish");
    }
  }
  // 再次冲线完成第 2 圈
  t += 5000;
  const evFinal = rp.update(cps[0].position, { x: cps[0].forward.x * 15, y: 0, z: cps[0].forward.z * 15 }, t);
  if (evFinal.lapCompleted) events.push(`lap${evFinal.lapCompleted}`);
  if (evFinal.finished) events.push("finish");
  check(
    "计圈：起跑→两圈→完赛",
    events.join(",") === "start,lap1,lap2,finish",
    events.join(",")
  );
  check("圈速记录", rp.bestLapMs !== undefined && rp.bestLapMs > 0 && rp.finished, `best=${rp.bestLapMs}ms total=${rp.totalMs}ms`);
  const rpose = rp.respawnPose(spawn);
  check("重生点 = 最近检查点", Math.hypot(rpose.position.x - cps[0].position.x, rpose.position.z - cps[0].position.z) < 1, `(${rpose.position.x.toFixed(1)}, ${rpose.position.z.toFixed(1)})`);

  // 12) 逆向不计数
  const rp2 = new RaceProgress(cps, 2, track.roadWidth);
  const backVel = { x: -cps[0].forward.x * 10, y: 0, z: -cps[0].forward.z * 10 };
  const evBack = rp2.update(cps[0].position, backVel, 1000);
  check("逆向冲线不触发", evBack.passedCheckpoint === undefined && !rp2.started, `started=${rp2.started}`);
}

// ================= 峡谷天堑专项 =================
{
  const canyon = TRACKS.canyon;
  const { samples, totalLength } = sampleClosedSpline(canyon.controlPoints, 2);
  const oldMax = Math.max(
    sampleClosedSpline(TRACKS.sunrise.controlPoints, 2).totalLength,
    sampleClosedSpline(TRACKS.ridge.controlPoints, 2).totalLength
  );
  check("峡谷长度 ≥ 旧图 3 倍", totalLength >= oldMax * 3, `${totalLength.toFixed(0)}m vs ${oldMax.toFixed(0)}m ×3=${(oldMax * 3).toFixed(0)}m`);

  // 发卡弯（漂移优势弯）：连续同向转角 >150° 且半径 <40m
  const k = curvatures(samples, true);
  let hairpinCount = 0;
  let i2 = 0;
  while (i2 < k.length) {
    if (Math.abs(k[i2]) < 0.012) {
      i2++;
      continue;
    }
    const sign = Math.sign(k[i2]);
    let acc = 0;
    let maxAbs = 0;
    while (i2 < k.length && Math.sign(k[i2]) === sign && Math.abs(k[i2]) > 0.008) {
      acc += k[i2] * 2;
      maxAbs = Math.max(maxAbs, Math.abs(k[i2]));
      i2++;
    }
    if (Math.abs((acc * 180) / Math.PI) > 150 && 1 / maxAbs < 40) hairpinCount++;
  }
  check("峡谷 180° 发卡弯 ≥ 3", hairpinCount >= 3, `${hairpinCount} 处`);

  // 岔路（谷底绕路）已整体删除：峡谷只保留一处断桥，坠落改为传送回最近检查点。
  check("峡谷无岔路（仅断桥）", !("branches" in canyon), `branches 字段已移除`);

  // 13) 飞跃断口：全油门冲主环断桥（挖洞 trimesh），应飞越并落回桥面
  const wj = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
  wj.timestep = PHYSICS_DT;
  wj.createCollider(RAPIER.ColliderDesc.cuboid(600, 0.5, 600).setTranslation(0, -0.55, 0));
  const roadJ = buildRibbonGeometry(samples, canyon.roadWidth / 2 + 0.85, -canyon.roadWidth / 2 - 0.85, {
    skipWindows: canyon.gaps,
    widthZones: canyon.widthZones,
    ramps: canyon.ramps, // 断桥前的起跳台必须进碰撞体，否则测到的是没有坡的旧路面
  });
  wj.createCollider(RAPIER.ColliderDesc.trimesh(roadJ.positions, roadJ.indices).setFriction(1.0));
  // 断桥弹道：起跳/落地坐标全部由 canyon.json 的 gaps 弧长派生，
  // 这样重画样条后测试自动跟随，不会像写死坐标那样悄悄测到空气里。
  const gapJ = canyon.gaps![0];
  const sampleAtDist = (d: number) => {
    const dd = ((d % totalLength) + totalLength) % totalLength;
    return samples[Math.round(dd / 2) % samples.length];
  };
  const lipNear = sampleAtDist(gapJ.fromDist);
  const lipFar = sampleAtDist(gapJ.toDist);
  const deckY = Math.min(lipNear.position.y, lipFar.position.y);
  // 出生在断口前 ~160m 的直道上，沿切向朝断口加速
  const runUp = sampleAtDist(gapJ.fromDist - 160);
  const spawnJ = {
    position: { x: runUp.position.x, y: runUp.position.y + 0.8, z: runUp.position.z },
    yaw: Math.atan2(runUp.tangent.x, runUp.tangent.z),
  };
  // 沿行进方向的弧长投影：比裸 x 坐标稳，赛道换向也不会失效
  const along = (p: { x: number; z: number }) =>
    (p.x - lipNear.position.x) * lipNear.tangent.x + (p.z - lipNear.position.z) * lipNear.tangent.z;
  const gapLen = gapJ.toDist - gapJ.fromDist;
  const carJ = new VehiclePhysics(wj, CARS.falcon, spawnJ);
  step(wj, carJ, {}, 0.8);
  let crossed = false;
  let lipSpeed = 0;
  let apexY = 0;
  for (let t = 0; t < 14 / PHYSICS_DT; t++) {
    carJ.update({ throttle: 1, brake: 0, steer: 0, handbrake: false }, PHYSICS_DT);
    wj.step();
    const s = along(carJ.position());
    if (s > -4 && s < 2 && lipSpeed === 0) lipSpeed = carJ.speedKmh();
    if (s > 0 && s < gapLen + 20) apexY = Math.max(apexY, carJ.position().y);
    if (s > gapLen + 24) {
      crossed = true;
      break;
    }
  }
  const landPos = carJ.position();
  const landedOnDeck = crossed && landPos.y > deckY - 1.5;
  check(
    "飞坡：高速腾空飞越断桥",
    landedOnDeck && lipSpeed > 100,
    `起跳 ${lipSpeed.toFixed(0)} km/h，最高点 y=${apexY.toFixed(1)} → 落桥面 y=${landPos.y.toFixed(2)}（桥面 ${deckY.toFixed(2)}）`
  );
  // 断口宽度：够难（需借速）但三车都飞得过去
  const gapWidth = (canyon.gaps ?? []).reduce((m, g) => Math.max(m, g.toDist - g.fromDist), 0);
  check("断桥断口宽度在可飞范围", gapWidth >= 24 && gapWidth <= 30, `${gapWidth.toFixed(0)}m`);

  // 低速射程不足 → 坠入谷底，被判定坠落后传送回最近检查点
  const runUp2 = sampleAtDist(gapJ.fromDist - 70);
  const carJ2 = new VehiclePhysics(wj, CARS.falcon, {
    position: { x: runUp2.position.x, y: runUp2.position.y + 0.8, z: runUp2.position.z },
    yaw: Math.atan2(runUp2.tangent.x, runUp2.tangent.z),
  });
  step(wj, carJ2, {}, 0.6);
  let fell = false;
  let crossedSlow = false;
  let slowLip = 0;
  for (let t = 0; t < 15 / PHYSICS_DT; t++) {
    carJ2.update({ throttle: 0.45, brake: 0, steer: 0, handbrake: false }, PHYSICS_DT);
    wj.step();
    const p2 = carJ2.position();
    const s2 = along(p2);
    if (s2 > -4 && s2 < 2 && slowLip === 0) slowLip = carJ2.speedKmh();
    if (p2.y < deckY - 3.0 && s2 > 2) {
      fell = true;
      break;
    }
    if (s2 > gapLen + 20 && p2.y > deckY - 1.5) {
      crossedSlow = true;
      break;
    }
  }
  check("飞坡：低速坠入断口", fell && !crossedSlow, `起跳 ${slowLip.toFixed(0)} km/h → 坠落=${fell}`);

  // 14) 坠落传送：落到谷底后 hasFallenOff 判定成立，reset 回最近检查点
  step(wj, carJ2, {}, 2.0); // 继续下坠到谷底地面
  const fallenPos = carJ2.position();
  check(
    "坠落判定成立（相对路面下沉）",
    hasFallenOff(fallenPos, samples),
    `y=${fallenPos.y.toFixed(2)}（桥面 ${deckY.toFixed(2)}）`
  );
  // 在桥面上正常行驶不应被判为坠落
  const onDeck = sampleAtDist(gapJ.fromDist - 100);
  check(
    "桥面行驶不误判坠落",
    !hasFallenOff({ x: onDeck.position.x, y: onDeck.position.y + 0.8, z: onDeck.position.z }, samples),
    `y=${(onDeck.position.y + 0.8).toFixed(2)}`
  );

  // 传送：回到最近通过的检查点
  const cpsC = buildCheckpoints(samples, canyon.checkpointEvery, totalLength, trackExclusionWindows(canyon));
  const rpC = new RaceProgress(cpsC, canyon.laps, canyon.roadWidth);
  // 依次通过断口前的几个检查点
  let tC = 0;
  const beforeGap = cpsC.filter((cp) => samplesDistOf(samples, cp.position) < gapJ.fromDist);
  for (const cp of beforeGap) {
    tC += 3000;
    rpC.update(cp.position, { x: cp.forward.x * 15, y: 0, z: cp.forward.z * 15 }, tC);
  }
  const lastCp = beforeGap[beforeGap.length - 1];
  const pose = rpC.respawnPose(spawnJ);
  const backOnTrack = Math.hypot(pose.position.x - lastCp.position.x, pose.position.z - lastCp.position.z) < 1;
  carJ2.reset(pose);
  step(wj, carJ2, {}, 1.0); // 落稳
  const after = carJ2.position();
  check(
    "坠落后传送回最近检查点",
    backOnTrack && !hasFallenOff(after, samples),
    `送回 cp${lastCp.index} @ (${pose.position.x.toFixed(1)}, ${pose.position.z.toFixed(1)}), 落稳 y=${after.y.toFixed(2)}`
  );
  // 传送点必须在路面上（不是虚空/断口里）
  check(
    "传送点避开断口",
    !inWindows(samplesDistOf(samples, pose.position), trackExclusionWindows(canyon)),
    `弧长 ${samplesDistOf(samples, pose.position).toFixed(0)}m`
  );
}

// ================= 护栏完整性（每张图） =================
for (const track of Object.values(TRACKS)) {
  const { samples } = sampleClosedSpline(track.controlPoints, 2);
  const wallH = track.wallHeight;
  // 偏移拆分必须与 TrackScene 一致：半宽随加宽缩放，路缘+余量为固定 pad。
  // 否则加宽段测到的护栏位置和游戏里渲染的不是同一条。
  const PAD = 0.85 + 0.35;
  const half = track.roadWidth / 2;

  const walls = [PAD, -PAD].map((pad) =>
    buildWallSegments(samples, Math.sign(pad) * half, {
      closed: true,
      skipWindows: track.gaps,
      widthZones: track.widthZones,
      ramps: track.ramps,
      pad,
    })
  );
  const nearestWall = (x: number, z: number, segs: { center: { x: number; z: number } }[]) => {
    let d = Infinity;
    for (const s of segs) d = Math.min(d, Math.hypot(s.center.x - x, s.center.z - z));
    return d;
  };

  // 断口以外全程两侧都必须有护栏兜住（防掉出赛道）
  // 容差必须随加宽缩放，否则 200% 宽路段的护栏会被误判成缺口
  const holes: number[] = [];
  for (const s of samples) {
    if (inWindows(s.distance, track.gaps)) continue; // 断口本就无路
    const tol = half * widthScaleAt(s.distance, track.widthZones) + PAD + 2.5;
    const dl = nearestWall(s.position.x, s.position.z, walls[0]);
    const dr = nearestWall(s.position.x, s.position.z, walls[1]);
    if (dl > tol && dr > tol) holes.push(s.distance);
  }
  check(
    `[${track.id}] 护栏无缺口`,
    holes.length === 0,
    holes.length ? `缺口 @${holes.map((h) => h.toFixed(0)).join(",")}m` : `全程有护栏`
  );

  // 断口两端必须敞开，否则车撞墙而不是飞出去
  for (const g of track.gaps ?? []) {
    const lip = samples[Math.round(g.fromDist / 2) % samples.length];
    const mid = samples[Math.round((g.fromDist + g.toDist) / 2 / 2) % samples.length];
    const dMid = Math.min(
      nearestWall(mid.position.x, mid.position.z, walls[0]),
      nearestWall(mid.position.x, mid.position.z, walls[1])
    );
    check(
      `[${track.id}] 断口 ${g.fromDist}-${g.toDist}m 无护栏封堵`,
      dMid > half,
      `断口中点护栏净空 ${dMid.toFixed(1)}m（需 >${half.toFixed(1)}m），起跳沿 y=${lip.position.y.toFixed(2)}`
    );
  }
}

// ================= 新车差异化与平衡 =================
{
  const results: { id: string; v5: number; dz: number }[] = [];
  for (const id of ["falcon", "bison", "viper"]) {
    const wc = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
    wc.timestep = PHYSICS_DT;
    wc.createCollider(RAPIER.ColliderDesc.cuboid(600, 0.5, 600).setTranslation(0, -0.5, 0));
    const c = new VehiclePhysics(wc, CARS[id], { position: { x: 0, y: 1.2, z: 0 }, yaw: 0 });
    step(wc, c, {}, 0.8);
    const z0 = c.position().z;
    step(wc, c, { throttle: 1 }, 5);
    results.push({ id, v5: c.speedKmh(), dz: c.position().z - z0 });
  }
  for (const r of results) {
    check(`[${r.id}] 正常行驶`, r.v5 > 90 && r.dz > 60, `5s ${r.v5.toFixed(0)} km/h, ${r.dz.toFixed(0)}m`);
  }
  const vs = results.map((r) => r.v5);
  const spread = Math.max(...vs) - Math.min(...vs);
  check("三车性能差距可控", spread < 30, `5s 车速差 ${spread.toFixed(0)} km/h (${results.map((r) => `${r.id}:${r.v5.toFixed(0)}`).join(" ")})`);
}

console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
