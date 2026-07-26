import type { VehicleInput } from "@fable/shared";

/** 触屏按钮动作名，与键盘平行的第二输入源 */
export type TouchAction = "throttle" | "brake" | "handbrake" | "left" | "right";

/** 键盘 + 触屏输入采集（手柄支持见 Phase 6.4） */
export class Input {
  private keys = new Set<string>();
  /** 触屏按住的动作，与 keys 平行合并 */
  private touch = new Set<TouchAction>();
  /** 复位请求（按一次触发一次） */
  resetRequested = false;
  /** 手刹刚按下（边沿触发，供音效用） */
  private handbrakePressed = false;
  /** 静音切换请求（M 键） */
  private muteRequested = false;

  /** 焦点在输入框/滑条等控件上时，键盘归控件（房间码、音量滑条） */
  private inFormField(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || t.isContentEditable;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (this.inFormField(e)) return;
    this.keys.add(e.code);
    if (e.code === "KeyR") this.resetRequested = true;
    if (e.code === "KeyM") this.muteRequested = true;
    if (e.code === "Space") this.handbrakePressed = true;
    // 防止方向键/空格滚动页面
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
      e.preventDefault();
    }
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onBlur = () => this.clear();

  /** 丢弃按住的键与积压的边沿请求（失焦、打开设置浮层时用） */
  clear(): void {
    this.keys.clear();
    this.touch.clear();
    this.resetRequested = false;
    this.handbrakePressed = false;
    this.muteRequested = false;
  }

  /** 触屏按钮按下/抬起，由 TouchControls 调用 */
  setTouch(action: TouchAction, active: boolean): void {
    if (active) {
      // 触屏手刹同样要产出按下边沿，音效才有反馈
      if (action === "handbrake" && !this.touch.has("handbrake")) this.handbrakePressed = true;
      this.touch.add(action);
    } else {
      this.touch.delete(action);
    }
  }

  /** 触屏复位按钮 */
  requestReset(): void {
    this.resetRequested = true;
  }

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** 当前帧车辆输入（键盘与触屏取或） */
  vehicle(): VehicleInput {
    const left = this.down("KeyA", "ArrowLeft") || this.touch.has("left") ? 1 : 0;
    const right = this.down("KeyD", "ArrowRight") || this.touch.has("right") ? 1 : 0;
    return {
      throttle: this.down("KeyW", "ArrowUp") || this.touch.has("throttle") ? 1 : 0,
      brake: this.down("KeyS", "ArrowDown") || this.touch.has("brake") ? 1 : 0,
      steer: left - right,
      handbrake: this.down("Space") || this.touch.has("handbrake"),
    };
  }

  consumeReset(): boolean {
    const r = this.resetRequested;
    this.resetRequested = false;
    return r;
  }

  consumeHandbrakePress(): boolean {
    const h = this.handbrakePressed;
    this.handbrakePressed = false;
    return h;
  }

  consumeMuteToggle(): boolean {
    const m = this.muteRequested;
    this.muteRequested = false;
    return m;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.keys.clear();
    this.touch.clear();
  }
}
