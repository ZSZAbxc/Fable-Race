import * as THREE from "three";
import type { RemoteCar } from "../net/RemoteCar";

/** 前方多远内给大名牌 */
const AHEAD_RANGE = 200;
/** 后方多远内进屏幕底部条 */
const BEHIND_RANGE = 120;
/** 缩放到此距离就压到下限，再远也不继续缩：远处名牌保持可读 */
const SCALE_FALLOFF = 90;
/** 前方最多几个大名牌，超出的退回世界内小名牌，防止远距挤成一团 */
const AHEAD_MAX = 5;
/** 底部条最多显示几个，防止人多时糊满 */
const BEHIND_MAX = 4;

interface AheadRow {
  el: HTMLDivElement;
  used: boolean;
}

/**
 * 近距玩家提示（仅多人模式）：
 * - 前方 200m 内：车顶大名牌 + 半透明底框，投影到屏幕，距离越近越大。
 * - 后方 120m 内：屏幕底部一排小底框，按距离由近到远排列，用于感知被追。
 *
 * 走 DOM 而不是 three 的 Sprite，是为了拿到清晰的字体渲染和 CSS 圆角/模糊，
 * 且不受世界缩放影响（名牌尺寸只跟距离挂钩，不跟 FOV 投影尺寸挂钩）。
 */
export class ProximityTags {
  private ahead: HTMLDivElement;
  private behind: HTMLDivElement;
  /** 按 sessionId 复用 DOM，避免每帧重建 */
  private aheadRows = new Map<string, AheadRow>();

  private camPos = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private rel = new THREE.Vector3();
  private proj = new THREE.Vector3();
  /** 复用的排序缓冲，避免每帧分配 */
  private behindBuf: Array<{ name: string; color: string; dist: number; side: number }> = [];
  private aheadBuf: Array<{ id: string; rc: RemoteCar; dist: number }> = [];

  constructor() {
    this.ahead = document.getElementById("prox-ahead") as HTMLDivElement;
    this.behind = document.getElementById("prox-behind") as HTMLDivElement;
  }

  /** 每帧调用：相机已更新、远程车位姿已插值完之后 */
  update(camera: THREE.PerspectiveCamera, remotes: Map<string, RemoteCar>): void {
    if (!this.ahead || !this.behind) return;

    this.camPos.copy(camera.position);
    camera.getWorldDirection(this.camFwd);
    // 只取水平朝向：上下坡时不该把前车判成后车
    this.camFwd.y = 0;
    if (this.camFwd.lengthSq() < 1e-6) return;
    this.camFwd.normalize();

    for (const row of this.aheadRows.values()) row.used = false;
    this.behindBuf.length = 0;
    this.aheadBuf.length = 0;

    for (const [id, rc] of remotes) {
      if (!rc.live || !rc.root.visible) {
        rc.setNameTagVisible(true);
        continue;
      }

      this.rel.copy(rc.root.position).sub(this.camPos);
      const horizDist = Math.hypot(this.rel.x, this.rel.z);
      // 前后由相机水平朝向的投影符号决定
      const along = this.rel.x * this.camFwd.x + this.rel.z * this.camFwd.z;

      if (along > 0 && horizDist <= AHEAD_RANGE) {
        // 先收集，排序后只画最近的几个：200m 内可能挤进多辆车
        this.aheadBuf.push({ id, rc, dist: horizDist });
      } else if (along < 0 && horizDist <= BEHIND_RANGE) {
        rc.setNameTagVisible(true);
        // 左右手性：正 = 在我右后方
        const side = this.rel.x * this.camFwd.z - this.rel.z * this.camFwd.x;
        this.behindBuf.push({ name: rc.name, color: rc.color, dist: horizDist, side });
      } else {
        rc.setNameTagVisible(true);
      }
    }

    // 前方按距离取最近的若干个，超出的退回世界内小名牌
    this.aheadBuf.sort((a, b) => a.dist - b.dist);
    for (let i = 0; i < this.aheadBuf.length; i++) {
      const e = this.aheadBuf[i];
      if (i < AHEAD_MAX) {
        e.rc.setNameTagVisible(false);
        this.placeAhead(e.id, e.rc, camera, e.dist);
      } else {
        e.rc.setNameTagVisible(true);
      }
    }

    // 回收本帧没用到的前方名牌
    for (const [id, row] of this.aheadRows) {
      if (!row.used) {
        row.el.remove();
        this.aheadRows.delete(id);
      }
    }

    this.renderBehind();
  }

  private placeAhead(
    id: string,
    rc: RemoteCar,
    camera: THREE.PerspectiveCamera,
    dist: number
  ): void {
    // 车顶上方一点，别糊在车身上
    this.proj.copy(rc.root.position);
    this.proj.y += 2.1;
    this.proj.project(camera);

    // 投影出画面/在相机背后就不画
    if (
      this.proj.z > 1 ||
      this.proj.x < -1.1 ||
      this.proj.x > 1.1 ||
      this.proj.y < -1.1 ||
      this.proj.y > 1.1
    ) {
      const stale = this.aheadRows.get(id);
      if (stale) {
        stale.el.remove();
        this.aheadRows.delete(id);
      }
      return;
    }

    let row = this.aheadRows.get(id);
    if (!row) {
      const el = document.createElement("div");
      el.className = "prox-tag";
      el.innerHTML = `<span class="pt-dot"></span><span class="pt-name"></span><span class="pt-d"></span>`;
      (el.querySelector(".pt-dot") as HTMLElement).style.background = rc.color;
      (el.querySelector(".pt-name") as HTMLElement).textContent = rc.name.slice(0, 12);
      this.ahead.appendChild(el);
      row = { el, used: true };
      this.aheadRows.set(id, row);
    }
    row.used = true;

    const x = (this.proj.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.proj.y * 0.5 + 0.5) * window.innerHeight;
    // 近大远小，但夹在 0.72~1.15 之间。衰减按 SCALE_FALLOFF 而非 AHEAD_RANGE：
    // 否则 200m 归一化会让中距（70m 左右）的名牌被压到接近下限，反而比之前更小。
    const near = 1 - Math.min(dist / SCALE_FALLOFF, 1);
    const scale = 0.72 + near * 0.43;

    row.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    (row.el.querySelector(".pt-d") as HTMLElement).textContent = `${Math.round(dist)}m`;
  }

  private renderBehind(): void {
    if (this.behindBuf.length === 0) {
      if (this.behind.childElementCount > 0) this.behind.innerHTML = "";
      return;
    }
    this.behindBuf.sort((a, b) => a.dist - b.dist);
    const rows = this.behindBuf.slice(0, BEHIND_MAX);

    // 后方条目少且变化频繁，整体重建比 diff 简单，量级 <=4 无性能顾虑
    this.behind.innerHTML = rows
      .map((r) => {
        const arrow = r.side > 0 ? "↘" : "↙";
        const name = escapeHtml(r.name.slice(0, 10));
        return (
          `<div class="prox-back">` +
          `<span class="pb-dot" style="background:${escapeHtml(r.color)}"></span>` +
          `<span class="pb-name">${name}</span>` +
          `<span class="pb-d">${Math.round(r.dist)}m</span>` +
          `<span class="pb-arrow">${arrow}</span>` +
          `</div>`
        );
      })
      .join("");
  }

  /** 玩家退出房间：立刻收掉它的名牌，不等下一帧回收 */
  drop(id: string): void {
    const row = this.aheadRows.get(id);
    if (row) {
      row.el.remove();
      this.aheadRows.delete(id);
    }
  }

  /** 局间清理：DOM 容器是常驻的，内容得自己收 */
  clear(): void {
    for (const row of this.aheadRows.values()) row.el.remove();
    this.aheadRows.clear();
    if (this.behind) this.behind.innerHTML = "";
  }
}

/** 名字和颜色来自其他玩家输入，插 HTML 前必须转义 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
