/** 物理模拟固定步长 (Hz) */
export const PHYSICS_HZ = 60;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

/** 略强于现实的重力，让跳跃/落地更干脆（街机手感） */
export const GRAVITY_Y = -13.5;

/** 单个房间最大玩家数（朋友局） */
export const MAX_PLAYERS = 8;

/**
 * 网络状态上报频率 (Hz)。
 * 仅客户端发送侧约定；服务端当前不校验频率也不限速（公网开放前需补限流）。
 */
export const NET_SEND_HZ = 20;

/** 默认服务端口 */
export const DEFAULT_SERVER_PORT = 2567;
