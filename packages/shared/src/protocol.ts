/** 客户端 ↔ 服务端消息名（Colyseus onMessage/send） */
export const MSG = {
  /** C→S 本地权威车辆位姿（20Hz） */
  STATE: "s",
  /** C→S 大厅准备状态 (boolean) */
  READY: "ready",
  /** C→S 房主选图 (mapId) */
  SELECT_MAP: "map",
  /** C→S 大厅换车 (carId) */
  SELECT_CAR: "car",
  /** C→S 房主开始比赛 */
  START: "start",
  /** S→C 比赛开始广播 */
  STARTED: "started",
  /** S→C 全员完赛/超时，比赛结算 */
  RESULTS: "results",
  /** C→S 房主：返回大厅 */
  BACK_TO_LOBBY: "back",
} as const;

/** 房间阶段 */
export type RoomPhase = "lobby" | "racing" | "results";

/** C→S 位姿上报载荷（含水平速度，供服务端方向校验与名次估算） */
export interface PlayerStatePayload {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vz: number;
}

/** S→C 开赛广播载荷 */
export interface StartedPayload {
  /** 服务器时刻 + 倒计时后的正式起跑时间（epoch ms，按各端本地估算） */
  startAt: number;
  mapId: string;
}

/** 结算条目（按名次排序） */
export interface ResultEntry {
  id: string;
  name: string;
  color: string;
  rank: number;
  /** 总时间 ms；0 = 未完赛 (DNF) */
  totalMs: number;
  /** 最快圈 ms；0 = 无 */
  bestLapMs: number;
  /** 完成圈数 */
  laps: number;
}

export interface ResultsPayload {
  entries: ResultEntry[];
}

/** 起跑倒计时时长 */
export const COUNTDOWN_MS = 3000;

/** 第一名完赛后，其余玩家的完赛时限（超时 DNF） */
export const FINISH_TIMEOUT_MS = 90_000;

/** 名次刷新间隔 */
export const RANK_INTERVAL_MS = 500;

/** 远程车渲染插值延迟（ms）：缓冲网络抖动 */
export const INTERP_DELAY_MS = 120;
