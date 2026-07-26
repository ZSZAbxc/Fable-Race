import {
  CARS,
  CAR_ORDER,
  CAR_TAGLINES,
  DEFAULT_CAR_ID,
  TRACKS,
  carStatBars,
  type ResultEntry,
} from "@fable/shared";
import { fmtMs } from "./format";

export interface Profile {
  name: string;
  color: string;
  carId: string;
}

export interface LobbyPlayerView {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  carId: string;
}

const PALETTE = ["#e84118", "#f5a623", "#ffd23e", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#e91e63"];
const LS_NAME = "fable.name";
const LS_COLOR = "fable.color";
const LS_CAR = "fable.car";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** 主菜单 + 大厅 UI（DOM 覆盖层） */
export class MenuUI {
  onPractice?: (mapId: string) => void;
  onCreate?: () => void;
  onJoin?: (code: string) => void;
  onReady?: (ready: boolean) => void;
  onSelectMap?: (mapId: string) => void;
  /** 在大厅里换车时同步给服务端 */
  onSelectCar?: (carId: string) => void;
  onStart?: () => void;
  onLeave?: () => void;
  /** 结算面板：房主点"再来一局"（回大厅） */
  onBackToLobby?: () => void;

  private menu = el<HTMLDivElement>("menu");
  private lobby = el<HTMLDivElement>("lobby");
  private results = el<HTMLDivElement>("results");
  private pageHome = el<HTMLDivElement>("m-home");
  private pageSolo = el<HTMLDivElement>("m-solo");
  private pageMulti = el<HTMLDivElement>("m-multi");
  /** 车手设置区块：单人/多人共用同一份 DOM，切页时搬进当前页 */
  private driverBox = el<HTMLDivElement>("m-driver");
  private nameInput = el<HTMLInputElement>("m-name");
  private colorsBox = el<HTMLDivElement>("m-colors");
  private carsBox = el<HTMLDivElement>("m-cars");
  private mapSelect = el<HTMLSelectElement>("m-map");
  private codeInput = el<HTMLInputElement>("m-code");
  private errorBox = el<HTMLDivElement>("m-error");
  private lobbyCode = el<HTMLSpanElement>("l-code");
  private lobbyPlayers = el<HTMLDivElement>("l-players");
  private lobbyMap = el<HTMLSelectElement>("l-map");
  private readyBtn = el<HTMLButtonElement>("l-ready");
  private startBtn = el<HTMLButtonElement>("l-start");
  private lobbyHint = el<HTMLDivElement>("l-hint");

  private selectedColor: string;
  private selectedCar: string;
  private myReady = false;

  constructor() {
    // 名字/颜色/车辆持久化
    this.nameInput.value = localStorage.getItem(LS_NAME) ?? `车手${Math.floor(Math.random() * 900 + 100)}`;
    this.selectedColor = localStorage.getItem(LS_COLOR) ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
    if (!PALETTE.includes(this.selectedColor)) this.selectedColor = PALETTE[0];
    this.selectedCar = localStorage.getItem(LS_CAR) ?? DEFAULT_CAR_ID;
    if (!CARS[this.selectedCar]) this.selectedCar = DEFAULT_CAR_ID;

    // 色板
    for (const c of PALETTE) {
      const sw = document.createElement("div");
      sw.className = "swatch" + (c === this.selectedColor ? " sel" : "");
      sw.style.background = c;
      sw.addEventListener("click", () => {
        this.selectedColor = c;
        localStorage.setItem(LS_COLOR, c);
        this.colorsBox.querySelectorAll(".swatch").forEach((s) => s.classList.remove("sel"));
        sw.classList.add("sel");
      });
      this.colorsBox.appendChild(sw);
    }

    // 车库卡片（遍历注册表 + 属性条）
    this.buildCarCards();

    // 地图下拉（遍历注册表）
    for (const sel of [this.mapSelect, this.lobbyMap]) {
      for (const t of Object.values(TRACKS)) {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = `${t.name} ${"★".repeat(t.difficulty)} · ${t.laps}圈`;
        sel.appendChild(opt);
      }
    }
    // 单机练习额外提供试车场
    const pg = document.createElement("option");
    pg.value = "playground";
    pg.textContent = "自由试车场";
    this.mapSelect.appendChild(pg);

    // 一级 → 二级 / 二级 → 一级
    el<HTMLButtonElement>("m-go-solo").addEventListener("click", () => this.showPage("solo"));
    el<HTMLButtonElement>("m-go-multi").addEventListener("click", () => this.showPage("multi"));
    el<HTMLButtonElement>("m-solo-back").addEventListener("click", () => this.showPage("home"));
    el<HTMLButtonElement>("m-multi-back").addEventListener("click", () => this.showPage("home"));

    el<HTMLButtonElement>("m-practice").addEventListener("click", () => {
      this.saveName();
      this.onPractice?.(this.mapSelect.value);
    });
    el<HTMLButtonElement>("m-create").addEventListener("click", () => {
      this.saveName();
      this.onCreate?.();
    });
    el<HTMLButtonElement>("m-join").addEventListener("click", () => this.tryJoin());
    this.codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.tryJoin();
    });

    this.readyBtn.addEventListener("click", () => {
      this.myReady = !this.myReady;
      this.readyBtn.textContent = this.myReady ? "取消准备" : "准备";
      this.onReady?.(this.myReady);
    });
    this.startBtn.addEventListener("click", () => this.onStart?.());
    this.lobbyMap.addEventListener("change", () => this.onSelectMap?.(this.lobbyMap.value));
    el<HTMLButtonElement>("l-leave").addEventListener("click", () => this.onLeave?.());
    el<HTMLButtonElement>("r-again").addEventListener("click", () => this.onBackToLobby?.());
    el<HTMLButtonElement>("r-leave").addEventListener("click", () => this.onLeave?.());
  }

  /**
   * 主菜单内的三级页面切换。车手设置（昵称/涂装/赛车）只存在一份 DOM，
   * 切到子页时移动进去，避免两套控件状态不同步。
   */
  private showPage(page: "home" | "solo" | "multi"): void {
    this.pageHome.style.display = page === "home" ? "" : "none";
    this.pageSolo.style.display = page === "solo" ? "" : "none";
    this.pageMulti.style.display = page === "multi" ? "" : "none";

    if (page === "solo") el<HTMLDivElement>("m-solo-driver").appendChild(this.driverBox);
    else if (page === "multi") el<HTMLDivElement>("m-multi-driver").appendChild(this.driverBox);
    this.driverBox.style.display = page === "home" ? "none" : "";

    if (page !== "multi") this.setError("");
  }

  private tryJoin() {
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      this.setError("请输入 4 位房间码");
      return;
    }
    this.saveName();
    this.onJoin?.(code);
  }

  /** 选车卡片：名称 + 定位标语 + 4 条属性条 */
  private buildCarCards() {
    const bars: [keyof ReturnType<typeof carStatBars>, string][] = [
      ["speed", "极速"],
      ["accel", "加速"],
      ["grip", "抓地"],
      ["drift", "漂移"],
    ];
    for (const id of CAR_ORDER) {
      const car = CARS[id];
      if (!car) continue;
      const st = carStatBars(car);
      const card = document.createElement("div");
      card.className = "car-card" + (id === this.selectedCar ? " sel" : "");
      card.innerHTML =
        `<div class="cc-info"><div class="cc-name">${car.name}</div>` +
        `<div class="cc-tag">${CAR_TAGLINES[id] ?? ""}</div></div>` +
        `<div class="cc-bars">` +
        bars
          .map(([k, label]) => `<span>${label}</span><div class="cc-bar"><i style="width:${st[k]}%"></i></div>`)
          .join("") +
        `</div>`;
      card.addEventListener("click", () => {
        this.selectedCar = id;
        localStorage.setItem(LS_CAR, id);
        this.carsBox.querySelectorAll(".car-card").forEach((c) => c.classList.remove("sel"));
        card.classList.add("sel");
        this.onSelectCar?.(id);
      });
      this.carsBox.appendChild(card);
    }
  }

  private saveName() {
    localStorage.setItem(LS_NAME, this.profile().name);
  }

  profile(): Profile {
    return {
      name: this.nameInput.value.trim() || "无名车手",
      color: this.selectedColor,
      carId: this.selectedCar,
    };
  }

  /** 回主菜单一级页面（游戏内返回、断线回退都走这里） */
  showMenu(page: "home" | "solo" | "multi" = "home"): void {
    this.menu.style.display = "flex";
    this.lobby.style.display = "none";
    this.results.style.display = "none";
    this.showPage(page);
  }

  showLobby(code: string): void {
    this.menu.style.display = "none";
    this.lobby.style.display = "flex";
    this.results.style.display = "none";
    this.lobbyCode.textContent = code;
    this.myReady = false;
    this.readyBtn.textContent = "准备";
  }

  /** 结算面板 */
  showResults(entries: ResultEntry[], meId: string, isHost: boolean, trackName: string): void {
    this.menu.style.display = "none";
    this.lobby.style.display = "none";
    this.results.style.display = "flex";

    const mine = entries.find((e) => e.id === meId);
    el<HTMLHeadingElement>("r-title").textContent = mine
      ? mine.totalMs > 0
        ? `你的名次：第 ${mine.rank} 名`
        : "未完赛"
      : "比赛结束";
    el<HTMLDivElement>("r-sub").textContent = trackName;
    el<HTMLDivElement>("r-list").innerHTML = entries
      .map((e) => {
        const total = e.totalMs > 0 ? fmtMs(e.totalMs) : `DNF · ${e.laps} 圈`;
        const best = e.bestLapMs > 0 ? `最快圈 ${fmtMs(e.bestLapMs)}` : "—";
        const me = e.id === meId ? " me" : "";
        return `<div class="res-row${me}"><span class="pos">${e.rank}</span><span class="dot" style="background:${e.color}"></span>${e.name}<span class="times">${total}<div class="best">${best}</div></span></div>`;
      })
      .join("");

    const againBtn = el<HTMLButtonElement>("r-again");
    againBtn.style.display = isHost ? "" : "none";
    el<HTMLDivElement>("r-hint").textContent = isHost ? "" : "等待房主开始下一局…";
  }

  hideAll(): void {
    this.menu.style.display = "none";
    this.lobby.style.display = "none";
    this.results.style.display = "none";
  }

  setError(msg: string): void {
    this.errorBox.textContent = msg;
  }

  setBusy(busy: boolean): void {
    for (const id of ["m-practice", "m-create", "m-join"]) {
      el<HTMLButtonElement>(id).disabled = busy;
    }
  }

  /** 大厅状态刷新（每次房间 state 变化调用） */
  setLobby(players: LobbyPlayerView[], meId: string, hostId: string, mapId: string): void {
    const isHost = meId === hostId;
    this.lobbyPlayers.innerHTML = players
      .map((p) => {
        const host = p.id === hostId ? `<span class="tag">房主</span>` : "";
        const me = p.id === meId ? `<span class="tag">(我)</span>` : "";
        const rd = p.ready ? `<span class="rd">已准备</span>` : `<span class="rd no">未准备</span>`;
        const car = CARS[p.carId]?.name ?? "";
        return `<div class="lp"><span class="dot" style="background:${p.color}"></span>${p.name} ${me}${host}<span class="carn">${car}</span>${rd}</div>`;
      })
      .join("");

    if (this.lobbyMap.value !== mapId) this.lobbyMap.value = mapId;
    this.lobbyMap.disabled = !isHost;
    this.startBtn.style.display = isHost ? "" : "none";

    const others = players.filter((p) => p.id !== hostId);
    const allReady = others.every((p) => p.ready);
    this.lobbyHint.textContent = isHost
      ? allReady
        ? "全员就绪，可以开始"
        : "等待玩家准备（也可直接开始）"
      : "等待房主开始比赛…";
  }
}
