import { RaceProgress, type SpawnPose, type TrackConfig, type VehiclePhysics } from "@fable/shared";
import type { TrackScene } from "../track/TrackScene";
import { audio } from "../audio/AudioSystem";
import type { Hud } from "../ui/hud";

/**
 * 计圈控制器：车辆位置 → RaceProgress → HUD/场景反馈。
 * 单机模式下它就是裁判；联机模式下服务端才是裁判，本地这份只用于
 * 即时的圈速显示与检查点引导（同一份 RaceProgress 逻辑，判定一致）。
 */
export class RaceController {
  readonly progress: RaceProgress;

  constructor(
    private trackScene: TrackScene,
    private track: TrackConfig,
    private hud: Hud,
    private online = false
  ) {
    this.progress = new RaceProgress(trackScene.checkpoints, track.laps, track.roadWidth);
    hud.setRaceVisible(true);
    if (!online) {
      hud.banner(`${track.name} · ${track.laps} 圈 —— 冲过起点线开始计时`, 4000);
    }
    trackScene.setActiveCheckpoint(0);
  }

  update(car: VehiclePhysics, nowMs: number): void {
    const p = this.progress;
    const ev = p.update(car.position(), car.body.linvel(), nowMs);

    // 中途检查点不发声。起点检查点（index 0）的每一次通过必然同时是
    // started / lapCompleted / finished 之一（见 RaceProgress.update），
    // 由下面那几声各自代表，这里无需再补一声。

    if (ev.started && !this.online) this.hud.banner("计时开始！", 1500);
    if (ev.lapCompleted && !ev.finished) {
      const lapText = this.hud.fmt(p.lastLapMs!);
      this.hud.banner(`第 ${ev.lapCompleted} 圈完成 · ${lapText}`, 2500);
      audio.play("lap");
    }
    if (ev.finished) {
      audio.play("finish");
      if (this.online) {
        this.hud.banner(`完赛！总时间 ${this.hud.fmt(p.totalMs!)} —— 等待其他车手…`, 4000);
      } else {
        this.hud.banner(
          `完赛！总时间 ${this.hud.fmt(p.totalMs!)} · 最快圈 ${this.hud.fmt(p.bestLapMs!)}（按 R 重新开始）`,
          0
        );
      }
    }

    this.trackScene.setActiveCheckpoint(p.nextCheckpoint);
    this.hud.setRace({
      lap: p.displayLap(),
      totalLaps: p.totalLaps,
      currentMs: p.currentLapMs(nowMs),
      lastMs: p.lastLapMs,
      bestMs: p.bestLapMs,
    });
  }

  /** R 键：单机完赛后重开一局，否则回最近检查点 */
  respawnPose(fallback: SpawnPose): SpawnPose {
    if (this.progress.finished && !this.online) {
      this.progress.restart();
      this.trackScene.setActiveCheckpoint(0);
      this.hud.banner("重新开始 —— 冲过起点线计时", 2500);
      return fallback;
    }
    return this.progress.respawnPose(fallback);
  }
}
