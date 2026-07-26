/**
 * 网络端到端冒烟测试：进程内起 Colyseus 服务，两个真实 colyseus.js 客户端走完
 * 创建→码加入→位姿同步→大厅→开赛→【模拟双人跑完整场比赛】→权威计圈/名次/结算→回大厅→房主迁移。
 * 运行: pnpm --filter @fable/server smoke
 */
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room } from "colyseus.js";
import {
  MSG,
  TRACKS,
  buildCheckpoints,
  sampleClosedSpline,
  type Checkpoint,
  type ResultsPayload,
  type StartedPayload,
} from "@fable/shared";
import { RaceRoom } from "../src/rooms/RaceRoom";

const PORT = 2599;

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  if (!ok) failures++;
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await wait(50);
  }
  return cond();
}

/** 沿检查点序列上报位姿（模拟驾驶） */
async function drive(room: Room, cps: Checkpoint[], fromIdx: number, count: number) {
  for (let k = 0; k < count; k++) {
    const cp = cps[(fromIdx + k) % cps.length];
    room.send(MSG.STATE, {
      x: cp.position.x,
      y: cp.position.y + 0.7,
      z: cp.position.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      vx: cp.forward.x * 15,
      vz: cp.forward.z * 15,
    });
    await wait(5);
  }
}

const server = new Server({ transport: new WebSocketTransport() });
server.define("race", RaceRoom);
await server.listen(PORT);

const endpoint = `ws://127.0.0.1:${PORT}`;

// 1) 创建房间：4 位房间码（测试用 100ms 倒计时）
const cA = new Client(endpoint);
const roomA: Room = await cA.create("race", { name: "Alice", color: "#ff5533", mapId: "sunrise", countdownMs: 100 });
check("创建房间：4 位房间码", /^[A-Z2-9]{4}$/.test(roomA.roomId), roomA.roomId);

// 2) 房间码加入
const cB = new Client(endpoint);
const roomB: Room = await cB.joinById(roomA.roomId, { name: "Bob", color: "#3388ff" });
const startedOnB: StartedPayload[] = [];
const resultsOnA: ResultsPayload[] = [];
const resultsOnB: ResultsPayload[] = [];
roomB.onMessage(MSG.STARTED, (m: StartedPayload) => startedOnB.push(m));
roomA.onMessage(MSG.STARTED, () => {});
roomA.onMessage(MSG.RESULTS, (m: ResultsPayload) => resultsOnA.push(m));
roomB.onMessage(MSG.RESULTS, (m: ResultsPayload) => resultsOnB.push(m));

await waitFor(() => roomB.state.players?.size === 2 && roomA.state.players?.size === 2);
check("双端看到 2 名玩家", roomA.state.players.size === 2 && roomB.state.players.size === 2, `A=${roomA.state.players.size} B=${roomB.state.players.size}`);
check("房主 = 先进者", roomA.state.hostId === roomA.sessionId && roomB.state.hostId === roomA.sessionId, roomA.state.hostId);
const bobOnA = roomA.state.players.get(roomB.sessionId);
check("玩家信息同步", bobOnA?.name === "Bob" && bobOnA?.color === "#3388ff", `${bobOnA?.name} ${bobOnA?.color}`);

// 3) 位姿上报 → 对端可见
roomA.send(MSG.STATE, { x: 5, y: 1.25, z: -70, qx: 0, qy: 0.5, qz: 0, qw: 0.866, vx: 0, vz: 0 });
const synced = await waitFor(() => {
  const a = roomB.state.players.get(roomA.sessionId);
  return a && Math.abs(a.x - 5) < 0.01 && Math.abs(a.qy - 0.5) < 0.01;
});
check("位姿同步 A→B", synced, `x=${roomB.state.players.get(roomA.sessionId)?.x}`);

// 4) 准备 + 房主选图权限
roomB.send(MSG.READY, true);
roomB.send(MSG.SELECT_MAP, "ridge");
await waitFor(() => roomA.state.players.get(roomB.sessionId)?.ready === true);
check("准备状态同步", roomA.state.players.get(roomB.sessionId)?.ready === true, "Bob ready");
check("非房主选图被拒", roomA.state.mapId === "sunrise", roomA.state.mapId);

// 5) 开赛
roomA.send(MSG.START);
await waitFor(() => startedOnB.length > 0 && roomB.state.phase === "racing");
const a2 = roomB.state.players.get(roomA.sessionId);
const b2 = roomB.state.players.get(roomB.sessionId);
check("开赛广播 + 阶段切换", startedOnB.length === 1 && roomB.state.phase === "racing", `startAt-now=${startedOnB[0]?.startAt - Date.now()}ms`);
check("格子位分配", a2?.spawnIndex === 0 && b2?.spawnIndex === 1, `A=${a2?.spawnIndex} B=${b2?.spawnIndex}`);
await wait(250); // 等 100ms 倒计时结束

// 6) 模拟比赛：sunrise 3 圈。A 先跑 1 整圈，B 只跑半圈 → 名次 A 第 1
const track = TRACKS.sunrise;
const { samples, totalLength } = sampleClosedSpline(track.controlPoints, 2);
const cps = buildCheckpoints(samples, track.checkpointEvery, totalLength);
const N = cps.length;

await drive(roomA, cps, 0, N); // A: 过起点 + 1 圈中所有点（尚未二次冲线）
await drive(roomB, cps, 0, Math.floor(N / 2)); // B: 半圈
await wait(700); // 等名次刷新（500ms 间隔）
const aState = roomA.state.players.get(roomA.sessionId);
const bState = roomA.state.players.get(roomB.sessionId);
check("实时名次：A 领先", aState?.rank === 1 && bState?.rank === 2, `A=#${aState?.rank} B=#${bState?.rank}`);

// A 跑完剩余 2 圈 + 冲线
await drive(roomA, cps, 0, N * 2 + 1);
await waitFor(() => roomA.state.players.get(roomA.sessionId)?.finished === true);
const aFin = roomA.state.players.get(roomA.sessionId);
check("A 完赛（服务端权威）", aFin?.finished === true && aFin?.totalMs > 0, `total=${aFin?.totalMs}ms best=${aFin?.bestLapMs}ms`);
check("圈速已记录", aFin?.bestLapMs > 0 && aFin?.lastLapMs > 0, `best=${aFin?.bestLapMs}ms`);
check("未全员完赛不结算", resultsOnA.length === 0, `results=${resultsOnA.length}`);

// B 跑完剩余圈数 → 全员完赛 → 结算
await drive(roomB, cps, Math.floor(N / 2), N - Math.floor(N / 2) + N * 2 + 1);
await waitFor(() => resultsOnA.length > 0 && resultsOnB.length > 0);
const entries = resultsOnA[0]?.entries ?? [];
check(
  "结算广播：A 第一 B 第二",
  entries.length === 2 && entries[0]?.name === "Alice" && entries[1]?.name === "Bob",
  entries.map((e) => `${e.rank}.${e.name} ${e.totalMs}ms`).join(" | ")
);
check("结算数据完整", entries.every((e) => e.totalMs > 0 && e.bestLapMs > 0 && e.laps === 3), `laps=${entries.map((e) => e.laps).join(",")}`);
await waitFor(() => roomB.state.phase === "results");
check("阶段 → results", roomB.state.phase === "results", roomB.state.phase);

// 7) 返回大厅（房主权限）
roomB.send(MSG.BACK_TO_LOBBY); // 非房主 → 拒绝
await wait(250);
check("非房主回大厅被拒", roomA.state.phase === "results", roomA.state.phase);
roomA.send(MSG.BACK_TO_LOBBY);
await waitFor(() => roomB.state.phase === "lobby");
const bAfter = roomB.state.players.get(roomB.sessionId);
check("回大厅：状态重置", roomB.state.phase === "lobby" && bAfter?.ready === false && bAfter?.rank === 0, `phase=${roomB.state.phase} ready=${bAfter?.ready}`);

// 8) 房主离开 → 迁移
await roomA.leave();
await waitFor(() => roomB.state.hostId === roomB.sessionId && roomB.state.players.size === 1);
check("房主迁移", roomB.state.hostId === roomB.sessionId, roomB.state.hostId);

await roomB.leave();
await wait(200);

console.log(failures === 0 ? "\n网络冒烟全部通过 ✔" : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
