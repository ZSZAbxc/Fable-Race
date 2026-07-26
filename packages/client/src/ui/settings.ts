import { audio } from "../audio/AudioSystem";
import { TouchControls } from "./touch";

/**
 * 设置浮层（二级界面）：任意界面都可通过齿轮或 Esc 打开。
 *
 * 音量走 AudioSystem 的 master gain，所以一处调整对引擎声、胎噪、
 * 撞击、UI 音全部生效。数值由 AudioSystem 自己持久化到 localStorage，
 * 这里只负责 UI 与同步。
 */
export class Settings {
  private root = document.getElementById("settings") as HTMLDivElement;
  private gear = document.getElementById("gear") as HTMLButtonElement;
  private closeBtn = document.getElementById("s-close") as HTMLButtonElement;
  private vol = document.getElementById("s-vol") as HTMLInputElement;
  private volNum = document.getElementById("s-vol-num") as HTMLSpanElement;
  private muteBtn = document.getElementById("s-mute") as HTMLButtonElement;
  private touchBtn = document.getElementById("s-touch") as HTMLButtonElement;
  private touchNote = document.getElementById("s-touch-num") as HTMLSpanElement;

  private open = false;
  /** 打开/关闭时通知外部（游戏内需要屏蔽车辆输入） */
  onToggle?: (open: boolean) => void;
  /** 触屏按键开关变化，交给外部即时应用到 TouchControls */
  onTouchControlsChanged?: (on: boolean) => void;

  constructor() {
    this.gear.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.setOpen(false));

    // 点遮罩空白处关闭，点面板内部不关
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.setOpen(false);
    });

    // input 事件覆盖拖动与键盘方向键，拖动过程实时生效便于试听
    this.vol.addEventListener("input", () => {
      const pct = Number(this.vol.value);
      audio.setVolume(pct / 100);
      // 拖动音量时自动解除静音，否则"调了没声"会让人以为坏了
      if (pct > 0 && audio.isMuted) audio.setMuted(false);
      this.syncFromAudio();
    });

    this.muteBtn.addEventListener("click", () => {
      audio.toggleMuted();
      audio.play("ui_click");
      this.syncFromAudio();
    });

    this.touchBtn.addEventListener("click", () => {
      const next = !TouchControls.shouldEnable();
      // 显式写入偏好：一旦用户手动切过，就不再跟随自动检测
      TouchControls.setPreference(next);
      audio.play("ui_click");
      this.onTouchControlsChanged?.(next);
      this.syncTouch();
    });

    window.addEventListener("keydown", this.onKey);
    this.syncFromAudio();
    this.syncTouch();
  }

  /** 刷新触屏开关 UI；注明当前是自动判定还是手动覆盖 */
  private syncTouch(): void {
    const on = TouchControls.shouldEnable();
    this.touchBtn.textContent = on ? "隐藏" : "显示";
    this.touchBtn.classList.toggle("on", !on);
    this.touchBtn.setAttribute("aria-pressed", String(!on));
    this.touchNote.textContent =
      TouchControls.getPreference() === null
        ? on
          ? "自动：检测到触屏"
          : "自动：未检测到触屏"
        : "已手动设置";
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== "Escape" || e.repeat) return;
    e.preventDefault();
    this.toggle();
  };

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(v: boolean): void {
    this.open = v;
    this.root.style.display = v ? "flex" : "none";
    // 打开时隐藏齿轮，避免和浮层里的关闭键重复
    this.gear.style.display = v ? "none" : "block";
    if (v) {
      this.syncFromAudio();
      this.syncTouch();
      // 打开设置本身就是用户手势，顺便解锁音频，让试听立刻有声
      void audio.unlock();
    }
    this.onToggle?.(v);
  }

  /** 从音频系统回读状态刷新 UI（M 键静音后也要调用，保持一致） */
  syncFromAudio(): void {
    const pct = Math.round(audio.currentVolume * 100);
    this.vol.value = String(pct);
    this.volNum.textContent = audio.isMuted ? "静音" : `${pct}%`;
    this.muteBtn.textContent = audio.isMuted ? "取消静音" : "静音";
    this.muteBtn.classList.toggle("on", audio.isMuted);
    this.muteBtn.setAttribute("aria-pressed", String(audio.isMuted));
    // 屏幕阅读器需要百分比之外的语义值
    this.vol.setAttribute("aria-valuetext", audio.isMuted ? "静音" : `${pct}%`);
  }
}
