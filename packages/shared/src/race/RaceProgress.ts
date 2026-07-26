import type { SpawnPose, Vec3Like } from "../types";
import type { Checkpoint } from "../track/builder";

/** 单帧比赛事件（由 update 返回，客户端据此做 UI/音效） */
export interface RaceEvents {
  /** 刚通过的检查点索引 */
  passedCheckpoint?: number;
  /** 冲过起点线，计时开始 */
  started?: boolean;
  /** 完成了一圈（值 = 已完成圈数） */
  lapCompleted?: number;
  /** 完成全部圈数 */
  finished?: boolean;
}

/**
 * 计圈/计时/重生逻辑：按顺序通过检查点（防抄近路），
 * checkpoint 0 = 起点/终点线。纯逻辑无物理依赖，客户端与服务端共用。
 */
export class RaceProgress {
  readonly totalLaps: number;

  /** 下一个应通过的检查点索引 */
  nextCheckpoint = 0;
  lapsCompleted = 0;
  /** 累计通过检查点数（名次排序用，单调递增） */
  totalCpPassed = 0;
  started = false;
  finished = false;

  lastLapMs?: number;
  bestLapMs?: number;
  totalMs?: number;

  private checkpoints: Checkpoint[];
  private triggerRadiusSq: number;
  private raceStartT = 0;
  private lapStartT = 0;
  private lastPassed?: Checkpoint;

  constructor(checkpoints: Checkpoint[], totalLaps: number, roadWidth: number) {
    this.checkpoints = checkpoints;
    this.totalLaps = totalLaps;
    const r = roadWidth / 2 + 2.5;
    this.triggerRadiusSq = r * r;
  }

  /** 每帧调用；tMs 为当前时间（毫秒） */
  update(pos: Vec3Like, vel: Vec3Like, tMs: number): RaceEvents {
    const ev: RaceEvents = {};
    if (this.finished || this.checkpoints.length === 0) return ev;

    const cp = this.checkpoints[this.nextCheckpoint];
    const dx = pos.x - cp.position.x;
    const dz = pos.z - cp.position.z;
    const dy = pos.y - cp.position.y;
    if (dx * dx + dz * dz > this.triggerRadiusSq || Math.abs(dy) > 8) return ev;
    // 必须正向通过（速度与检查点朝向同向）
    if (vel.x * cp.forward.x + vel.z * cp.forward.z <= 0.5) return ev;

    ev.passedCheckpoint = cp.index;
    this.lastPassed = cp;
    this.totalCpPassed++;

    if (cp.index === 0) {
      if (!this.started) {
        this.started = true;
        this.raceStartT = tMs;
        this.lapStartT = tMs;
        ev.started = true;
      } else {
        const lapMs = tMs - this.lapStartT;
        this.lastLapMs = lapMs;
        if (this.bestLapMs === undefined || lapMs < this.bestLapMs) this.bestLapMs = lapMs;
        this.lapsCompleted++;
        this.lapStartT = tMs;
        ev.lapCompleted = this.lapsCompleted;
        if (this.lapsCompleted >= this.totalLaps) {
          this.finished = true;
          this.totalMs = tMs - this.raceStartT;
          ev.finished = true;
        }
      }
    }

    this.nextCheckpoint = (this.nextCheckpoint + 1) % this.checkpoints.length;
    return ev;
  }

  /** 当前圈已用时（未开始/已完赛返回 undefined） */
  currentLapMs(tMs: number): number | undefined {
    if (!this.started || this.finished) return undefined;
    return tMs - this.lapStartT;
  }

  /** 当前显示圈号（1 起） */
  displayLap(): number {
    return Math.min(this.lapsCompleted + 1, this.totalLaps);
  }

  /**
   * 比赛进度度量（单调递增，用于实时名次排序）：
   * 已过检查点数 + 向下一检查点推进的比例。
   */
  progressMetric(pos: Vec3Like): number {
    const n = this.checkpoints.length;
    if (n === 0) return 0;
    const next = this.checkpoints[this.nextCheckpoint];
    const prev = this.checkpoints[(this.nextCheckpoint - 1 + n) % n];
    const segLen = Math.hypot(next.position.x - prev.position.x, next.position.z - prev.position.z) || 1;
    const distToNext = Math.hypot(pos.x - next.position.x, pos.z - next.position.z);
    const frac = Math.min(1, Math.max(0, 1 - distToNext / segLen));
    return this.totalCpPassed + frac;
  }

  /** 重生位姿 = 最近通过的检查点（尚未通过任何点则用 fallback） */
  respawnPose(fallback: SpawnPose): SpawnPose {
    const cp = this.lastPassed;
    if (!cp) return fallback;
    return {
      position: { x: cp.position.x, y: cp.position.y + 0.8, z: cp.position.z },
      yaw: cp.yaw,
    };
  }

  /** 重开一局 */
  restart(): void {
    this.nextCheckpoint = 0;
    this.lapsCompleted = 0;
    this.totalCpPassed = 0;
    this.started = false;
    this.finished = false;
    this.lastLapMs = undefined;
    this.bestLapMs = undefined;
    this.totalMs = undefined;
    this.lastPassed = undefined;
  }
}
