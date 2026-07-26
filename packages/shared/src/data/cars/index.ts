import type { CarConfig } from "../../types";
import falcon from "./falcon.json";
import bison from "./bison.json";
import viper from "./viper.json";

/**
 * 车辆注册表——UI 与生成逻辑都遍历这里。
 * 新增车辆：加一个 JSON 文件 + 在此 import 一行。
 */
export const CARS: Record<string, CarConfig> = {
  [falcon.id]: falcon as CarConfig,
  [bison.id]: bison as CarConfig,
  [viper.id]: viper as CarConfig,
};

export const DEFAULT_CAR_ID = "falcon";

export function getCar(id: string): CarConfig {
  return CARS[id] ?? CARS[DEFAULT_CAR_ID];
}

/** 车库展示顺序 */
export const CAR_ORDER = ["falcon", "bison", "viper"] as const;

/** UI 属性条（0~100，仅展示用，由配置换算） */
export interface CarStatBars {
  /** 极速 */
  speed: number;
  /** 加速 */
  accel: number;
  /** 抓地/稳定 */
  grip: number;
  /** 漂移灵活度 */
  drift: number;
}

const norm = (v: number, lo: number, hi: number) =>
  Math.round(Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)));

export function carStatBars(c: CarConfig): CarStatBars {
  return {
    speed: norm(c.engine.maxSpeedKmh, 140, 190),
    // 推重比
    accel: norm(c.engine.maxForce / c.chassis.mass, 7, 10),
    grip: norm(c.friction.slip * c.friction.sideStiffness + c.aero.downforce * 0.35, 4.5, 8.0),
    drift: norm(c.drift.maxYawRate / c.drift.rearSideStiffness, 12, 30),
  };
}

/** 一句话定位（车库展示） */
export const CAR_TAGLINES: Record<string, string> = {
  falcon: "均衡后驱 · 好上手的全能选手",
  bison: "四驱重量级 · 出弯加速与落地最稳",
  viper: "轻量后驱 · 极速最高，漂移最刁",
};
