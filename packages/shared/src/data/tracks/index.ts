import type { TrackConfig } from "../../types";
import sunrise from "./sunrise.json";
import ridge from "./ridge.json";
import canyon from "./canyon.json";

/**
 * 赛道注册表——UI 与加载逻辑都遍历这里。
 * 新增赛道：加一个 JSON 文件 + 在此 import 一行。
 */
export const TRACKS: Record<string, TrackConfig> = {
  [sunrise.id]: sunrise as TrackConfig,
  [ridge.id]: ridge as TrackConfig,
  [canyon.id]: canyon as TrackConfig,
};

export const DEFAULT_TRACK_ID = "sunrise";

export function getTrack(id: string): TrackConfig {
  return TRACKS[id] ?? TRACKS[DEFAULT_TRACK_ID];
}
