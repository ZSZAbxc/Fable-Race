import { fmtMs } from "./format";

export interface RaceHudState {
  lap: number;
  totalLaps: number;
  currentMs?: number;
  lastMs?: number;
  bestMs?: number;
}

/** HUD：速度 / 圈数计时 / 名次 / 中央横幅 */
export class Hud {
  private speedEl = document.getElementById("speed")!;
  private raceEl = document.getElementById("race")!;
  private lapEl = document.getElementById("lap")!;
  private rankEl = document.getElementById("rank")!;
  private timeCurEl = document.getElementById("time-cur")!;
  private timeLastEl = document.getElementById("time-last")!;
  private timeBestEl = document.getElementById("time-best")!;
  private bannerEl = document.getElementById("banner")!;
  private quitEl = document.getElementById("quit") as HTMLButtonElement;
  private bannerTimer: number | undefined;

  readonly fmt = fmtMs;

  /** 游戏内"返回主界面"按钮：仅单人模式显示（联机退出走大厅的离开房间） */
  setQuitVisible(v: boolean): void {
    this.quitEl.style.display = v ? "block" : "none";
  }

  onQuit(fn: () => void): void {
    this.quitEl.addEventListener("click", fn);
  }

  /** 会话结束后复位 HUD，避免上一局的数字残留到下一局 */
  reset(): void {
    this.setRaceVisible(false);
    this.hideBanner();
    this.setSpeed(0);
    this.timeCurEl.textContent = "--:--.---";
    this.timeLastEl.textContent = "上圈 --:--.---";
    this.timeBestEl.textContent = "最佳 --:--.---";
  }

  setSpeed(kmh: number): void {
    this.speedEl.innerHTML = `${Math.round(kmh)}<span> km/h</span>`;
  }

  setRaceVisible(v: boolean): void {
    this.raceEl.style.display = v ? "block" : "none";
    if (!v) this.rankEl.style.display = "none";
  }

  setRace(s: RaceHudState): void {
    this.lapEl.textContent = `圈 ${s.lap} / ${s.totalLaps}`;
    this.timeCurEl.textContent = s.currentMs !== undefined ? fmtMs(s.currentMs) : "--:--.---";
    this.timeLastEl.textContent = `上圈 ${s.lastMs !== undefined ? fmtMs(s.lastMs) : "--:--.---"}`;
    this.timeBestEl.textContent = `最佳 ${s.bestMs !== undefined ? fmtMs(s.bestMs) : "--:--.---"}`;
  }

  /** 联机名次（rank=0 显示 -） */
  setRank(rank: number, total: number): void {
    this.rankEl.style.display = "block";
    this.rankEl.textContent = `名次 ${rank > 0 ? rank : "-"} / ${total}`;
  }

  /** 中央横幅；ms=0 表示常驻 */
  banner(text: string, ms: number): void {
    this.bannerEl.textContent = text;
    this.bannerEl.style.opacity = "1";
    if (this.bannerTimer !== undefined) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = undefined;
    if (ms > 0) {
      this.bannerTimer = window.setTimeout(() => {
        this.bannerEl.style.opacity = "0";
      }, ms);
    }
  }

  hideBanner(): void {
    this.bannerEl.style.opacity = "0";
  }
}
