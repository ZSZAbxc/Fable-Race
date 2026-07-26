import { Room, type Client, type Delayed } from "@colyseus/core";
import { MapSchema, Schema, type } from "@colyseus/schema";
import {
  COUNTDOWN_MS,
  DEFAULT_CAR_ID,
  DEFAULT_TRACK_ID,
  FINISH_TIMEOUT_MS,
  MAX_PLAYERS,
  MSG,
  RANK_INTERVAL_MS,
  RaceProgress,
  TRACKS,
  CARS,
  buildCheckpoints,
  getTrack,
  sampleClosedSpline,
  trackExclusionWindows,
  type PlayerStatePayload,
  type ResultEntry,
  type ResultsPayload,
  type RoomPhase,
  type StartedPayload,
} from "@fable/shared";

export class PlayerState extends Schema {
  @type("string") name = "Player";
  @type("string") color = "#e84118";
  @type("string") carId = DEFAULT_CAR_ID;
  @type("boolean") ready = false;
  @type("int8") spawnIndex = -1;
  // 车辆位姿（本地权威，20Hz 上报）
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") z = 0;
  @type("float32") qx = 0;
  @type("float32") qy = 0;
  @type("float32") qz = 0;
  @type("float32") qw = 1;
  // 比赛进度（服务端权威）
  @type("int8") lap = 0;
  @type("uint8") rank = 0;
  @type("boolean") finished = false;
  @type("uint32") lastLapMs = 0;
  @type("uint32") bestLapMs = 0;
  @type("uint32") totalMs = 0;
}

export class RaceState extends Schema {
  @type("string") phase: RoomPhase = "lobby";
  @type("string") mapId = DEFAULT_TRACK_ID;
  @type("string") hostId = "";
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}

interface JoinOptions {
  name?: string;
  color?: string;
  carId?: string;
  mapId?: string;
  /** 测试用：覆盖倒计时时长 */
  countdownMs?: number;
}

/** 4 位房间码（去掉易混字符） */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

/**
 * 一个房间 = 一局游戏。
 * 阶段机：lobby → racing → results → lobby。
 * 服务端权威：计圈/圈速/名次/结算全部由服务端 RaceProgress 判定，
 * 客户端只上报位姿（朋友局无需反作弊，但裁判必须一致）。
 */
export class RaceRoom extends Room<RaceState> {
  maxClients = MAX_PLAYERS;

  private spawnCounter = 0;
  private countdownMs = COUNTDOWN_MS;
  private startAt = 0;
  /** 每位玩家的服务端计圈器 */
  private progresses = new Map<string, RaceProgress>();
  /** 完赛顺序（sessionId） */
  private finishOrder: string[] = [];
  private finishTimeout?: Delayed;
  private rankInterval?: Delayed;

  onCreate(options: JoinOptions = {}) {
    this.roomId = generateRoomCode();
    this.setState(new RaceState());
    if (options.mapId && TRACKS[options.mapId]) this.state.mapId = options.mapId;
    if (typeof options.countdownMs === "number") {
      this.countdownMs = Math.min(10_000, Math.max(0, options.countdownMs));
    }

    this.onMessage(MSG.STATE, (client, data: PlayerStatePayload) => this.handleState(client, data));

    this.onMessage(MSG.READY, (client, ready: boolean) => {
      const p = this.state.players.get(client.sessionId);
      if (p && this.state.phase === "lobby") p.ready = !!ready;
    });

    this.onMessage(MSG.SELECT_MAP, (client, mapId: string) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== "lobby" || !TRACKS[mapId]) return;
      this.state.mapId = mapId;
    });

    this.onMessage(MSG.SELECT_CAR, (client, carId: string) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || this.state.phase !== "lobby" || !CARS[carId]) return;
      p.carId = carId;
    });

    this.onMessage(MSG.START, (client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
      this.startRace();
    });

    this.onMessage(MSG.BACK_TO_LOBBY, (client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase === "lobby") return;
      this.resetToLobby();
    });

    console.log(`[room] 创建房间 ${this.roomId}`);
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    const p = new PlayerState();
    if (options.name) p.name = String(options.name).slice(0, 16);
    if (options.color && /^#[0-9a-fA-F]{6}$/.test(options.color)) p.color = options.color;
    if (options.carId && CARS[options.carId]) p.carId = options.carId;
    this.state.players.set(client.sessionId, p);

    if (!this.state.hostId) this.state.hostId = client.sessionId;
    // 比赛中途加入：给格子位 + 计圈器，直接参赛
    if (this.state.phase === "racing") {
      p.spawnIndex = this.spawnCounter++;
      this.progresses.set(client.sessionId, this.createProgress());
      client.send(MSG.STARTED, { startAt: Date.now(), mapId: this.state.mapId } satisfies StartedPayload);
    }
    console.log(`[room ${this.roomId}] ${p.name} 加入（${this.state.players.size} 人）`);
  }

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.progresses.delete(client.sessionId);
    const idx = this.finishOrder.indexOf(client.sessionId);
    if (idx >= 0) this.finishOrder.splice(idx, 1);

    if (client.sessionId === this.state.hostId) {
      const next = this.state.players.keys().next();
      this.state.hostId = next.done ? "" : next.value;
    }
    // 剩余玩家都已完赛 → 直接结算
    if (this.state.phase === "racing" && this.state.players.size > 0 && this.allFinished()) {
      this.finishRace();
    }
    console.log(`[room ${this.roomId}] ${p?.name ?? client.sessionId} 离开（${this.state.players.size} 人）`);
  }

  onDispose() {
    this.clearTimers();
  }

  // ================= 比赛裁判 =================

  private createProgress(): RaceProgress {
    const track = getTrack(this.state.mapId);
    const { samples, totalLength } = sampleClosedSpline(track.controlPoints, 2);
    // 断口上方不设检查点（与客户端同一份窗口，裁判一致）
    const cps = buildCheckpoints(samples, track.checkpointEvery, totalLength, trackExclusionWindows(track));
    return new RaceProgress(cps, track.laps, track.roadWidth);
  }

  private startRace() {
    this.clearTimers();
    this.spawnCounter = 0;
    this.finishOrder = [];
    this.progresses.clear();

    this.state.players.forEach((p, id) => {
      p.spawnIndex = this.spawnCounter++;
      p.lap = 0;
      p.rank = 0;
      p.finished = false;
      p.lastLapMs = 0;
      p.bestLapMs = 0;
      p.totalMs = 0;
      this.progresses.set(id, this.createProgress());
    });

    this.startAt = Date.now() + this.countdownMs;
    this.state.phase = "racing";
    this.broadcast(MSG.STARTED, { startAt: this.startAt, mapId: this.state.mapId } satisfies StartedPayload);
    this.rankInterval = this.clock.setInterval(() => this.updateRanks(), RANK_INTERVAL_MS);
    console.log(`[room ${this.roomId}] 开赛 ${this.state.mapId}，${this.spawnCounter} 人`);
  }

  private handleState(client: Client, data: PlayerStatePayload) {
    const p = this.state.players.get(client.sessionId);
    if (!p || typeof data?.x !== "number") return;
    p.x = data.x;
    p.y = data.y;
    p.z = data.z;
    p.qx = data.qx;
    p.qy = data.qy;
    p.qz = data.qz;
    p.qw = data.qw;

    // 服务端权威计圈
    if (this.state.phase !== "racing" || p.finished) return;
    const rp = this.progresses.get(client.sessionId);
    const now = Date.now();
    if (!rp || now < this.startAt) return;

    const ev = rp.update(
      { x: data.x, y: data.y, z: data.z },
      { x: data.vx ?? 0, y: 0, z: data.vz ?? 0 },
      now
    );
    if (ev.passedCheckpoint === undefined) return;

    p.lap = rp.displayLap();
    if (rp.lastLapMs !== undefined) p.lastLapMs = Math.round(rp.lastLapMs);
    if (rp.bestLapMs !== undefined) p.bestLapMs = Math.round(rp.bestLapMs);

    if (ev.finished) {
      p.finished = true;
      p.totalMs = Math.round(rp.totalMs ?? 0);
      this.finishOrder.push(client.sessionId);
      console.log(`[room ${this.roomId}] ${p.name} 完赛 #${this.finishOrder.length} (${p.totalMs}ms)`);
      if (this.allFinished()) {
        this.finishRace();
      } else if (this.finishOrder.length === 1) {
        // 第一名产生后，其余玩家限时完赛
        this.finishTimeout = this.clock.setTimeout(() => this.finishRace(), FINISH_TIMEOUT_MS);
      }
    }
  }

  private allFinished(): boolean {
    let all = true;
    this.state.players.forEach((p) => {
      if (!p.finished) all = false;
    });
    return all;
  }

  /** 名次：已完赛按冲线顺序，未完赛按进度度量 */
  private sortedIds(): string[] {
    const racing: { id: string; metric: number }[] = [];
    this.state.players.forEach((p, id) => {
      if (p.finished) return;
      const rp = this.progresses.get(id);
      racing.push({ id, metric: rp ? rp.progressMetric({ x: p.x, y: p.y, z: p.z }) : -1 });
    });
    racing.sort((a, b) => b.metric - a.metric);
    return [...this.finishOrder, ...racing.map((r) => r.id)];
  }

  private updateRanks() {
    if (this.state.phase !== "racing") return;
    this.sortedIds().forEach((id, i) => {
      const p = this.state.players.get(id);
      if (p) p.rank = i + 1;
    });
  }

  private finishRace() {
    if (this.state.phase !== "racing") return;
    this.clearTimers();
    this.updateRanksFinal();

    const entries: ResultEntry[] = this.sortedIds().map((id, i) => {
      const p = this.state.players.get(id)!;
      const rp = this.progresses.get(id);
      return {
        id,
        name: p.name,
        color: p.color,
        rank: i + 1,
        totalMs: p.finished ? p.totalMs : 0,
        bestLapMs: p.bestLapMs,
        laps: rp?.lapsCompleted ?? 0,
      };
    });
    this.state.phase = "results";
    this.broadcast(MSG.RESULTS, { entries } satisfies ResultsPayload);
    console.log(`[room ${this.roomId}] 结算：${entries.map((e) => `${e.rank}.${e.name}`).join(" ")}`);
  }

  private updateRanksFinal() {
    this.sortedIds().forEach((id, i) => {
      const p = this.state.players.get(id);
      if (p) p.rank = i + 1;
    });
  }

  private resetToLobby() {
    this.clearTimers();
    this.progresses.clear();
    this.finishOrder = [];
    this.state.players.forEach((p) => {
      p.ready = false;
      p.spawnIndex = -1;
      p.lap = 0;
      p.rank = 0;
      p.finished = false;
      p.lastLapMs = 0;
      p.bestLapMs = 0;
      p.totalMs = 0;
    });
    this.state.phase = "lobby";
    console.log(`[room ${this.roomId}] 返回大厅`);
  }

  private clearTimers() {
    this.finishTimeout?.clear();
    this.finishTimeout = undefined;
    this.rankInterval?.clear();
    this.rankInterval = undefined;
  }
}
