import type { Input, TouchAction } from "../core/Input";

/** 用户手动覆盖触屏按键显隐；缺省不写入，跟随自动检测 */
const PREF_KEY = "fable.touchControls";

/**
 * 触屏操控层。左下 = 前进/后退/漂移，右下 = 左/右，左上 = 复位。
 *
 * 只在检测到触屏设备时显示；DOM 常驻 index.html，这里只负责绑定。
 * 用 Pointer Events 统一鼠标与触摸，配合 setPointerCapture 让手指滑出
 * 按钮范围后仍归本按钮管 —— 否则快速搓屏会漏掉 pointerup，按键卡死。
 */
export class TouchControls {
  private root: HTMLElement | null;
  private input: Input;
  /** 每个按钮的解绑函数 */
  private unbinds: Array<() => void> = [];
  /** 是否启用（设备判定 + 用户偏好） */
  private active = false;
  /** 是否临时可见（结算/设置浮层会压低），与 active 正交 */
  private shown = true;

  constructor(input: Input) {
    this.input = input;
    this.root = document.getElementById("touch");
    if (!this.root) return;

    // 默认隐藏，再按偏好决定是否点亮 —— setEnabled(false) 在初始态会短路
    this.root.style.display = "none";
    this.setEnabled(TouchControls.shouldEnable());
  }

  /**
   * 启用/停用整套触屏控件。设置里切换时即时生效，无需重开。
   * 停用时解绑事件并松开所有按住态，避免残留油门。
   */
  setEnabled(on: boolean): void {
    if (!this.root || on === this.active) return;
    this.active = on;

    if (!on) {
      for (const u of this.unbinds) u();
      this.unbinds = [];
      this.releaseAll();
      this.root.style.display = "none";
      return;
    }

    this.root.style.display = this.shown ? "" : "none";
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>("[data-act]"))) {
      const act = el.dataset.act as TouchAction | "reset" | undefined;
      if (!act) continue;
      if (act === "reset") this.bindTap(el);
      else this.bindHold(el, act);
    }
  }

  get isEnabled(): boolean {
    return this.active;
  }

  /**
   * 触屏设备判定。
   *
   * 不能用 any-pointer/maxTouchPoints：前者只要"存在任一"粗指针就为真，
   * 后者在带触摸屏的 Windows 笔记本上同样 > 0 —— 两者都会把 PC 误判成手机。
   * 改判主指针：pointer: coarse 说明"主要"输入方式是手指，
   * hover: none 说明没有可悬停的鼠标。两者同时成立才是真正的触屏设备。
   */
  static isTouchDevice(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    const coarsePrimary = window.matchMedia("(pointer: coarse)").matches;
    const noHover = window.matchMedia("(hover: none)").matches;
    return coarsePrimary && noHover;
  }

  /** 用户显式偏好：null = 跟随自动检测，true/false = 强制 */
  static getPreference(): boolean | null {
    const v = localStorage.getItem(PREF_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  }

  static setPreference(v: boolean | null): void {
    if (v === null) localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, v ? "1" : "0");
  }

  /** 最终是否启用：用户偏好优先，未设置则跟随自动检测 */
  static shouldEnable(): boolean {
    return TouchControls.getPreference() ?? TouchControls.isTouchDevice();
  }

  /** 按住型：油门/刹车/手刹/左/右 */
  private bindHold(el: HTMLElement, act: TouchAction): void {
    const press = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      el.classList.add("on");
      this.input.setTouch(act, true);
    };
    const release = (e: PointerEvent) => {
      e.preventDefault();
      el.classList.remove("on");
      this.input.setTouch(act, false);
    };
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    // 指针被系统抢走（来电、通知）时也要松开，否则油门粘住
    el.addEventListener("lostpointercapture", release);
    this.unbinds.push(() => {
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("pointerup", release);
      el.removeEventListener("pointercancel", release);
      el.removeEventListener("lostpointercapture", release);
    });
  }

  /** 点一下型：复位 */
  private bindTap(el: HTMLElement): void {
    const tap = (e: PointerEvent) => {
      e.preventDefault();
      el.classList.add("on");
      this.input.requestReset();
      window.setTimeout(() => el.classList.remove("on"), 120);
    };
    el.addEventListener("pointerdown", tap);
    this.unbinds.push(() => el.removeEventListener("pointerdown", tap));
  }

  /**
   * 结算冻结 / 设置浮层打开时临时收起，避免盖住浮层按钮。
   * 与 setEnabled 正交：临时收起不改变启用状态，恢复时仍尊重用户偏好。
   */
  setVisible(v: boolean): void {
    this.shown = v;
    if (!this.active || !this.root) return;
    this.root.style.display = v ? "" : "none";
    if (!v) this.releaseAll();
  }

  /** 松开所有按住态（隐藏、暂停时用） */
  private releaseAll(): void {
    if (!this.root) return;
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>("[data-act]"))) {
      el.classList.remove("on");
      const act = el.dataset.act as TouchAction | "reset" | undefined;
      if (act && act !== "reset") this.input.setTouch(act, false);
    }
  }

  dispose(): void {
    for (const u of this.unbinds) u();
    this.unbinds = [];
    this.releaseAll();
    if (this.root) this.root.style.display = "none";
    this.active = false;
  }
}
