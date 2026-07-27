import { Capacitor } from "@capacitor/core";
import { Client, type Room } from "colyseus.js";
import { DEFAULT_SERVER_PORT } from "@fable/shared";

/** 线上服务器（APK 环境连接此地址） */
const REMOTE_SERVER = "fable-race-276577-9-1381713550.sh.run.tcloudbase.com";

export interface JoinProfile {
  name: string;
  color: string;
  carId?: string;
  mapId?: string;
}

/** 连接封装 */
export class NetClient {
  readonly client: Client;

  constructor() {
    if (Capacitor.isNativePlatform()) {
      // APK 环境：直连线上服务器
      this.client = new Client(`wss://${REMOTE_SERVER}`);
    } else {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // 开发环境(HTTP) Colyseus 在 2567，生产环境(HTTPS)跟页面同端口（nginx 代理）
      const port = location.protocol === "https:"
        ? (location.port ? `:${location.port}` : "")
        : `:${DEFAULT_SERVER_PORT}`;
      this.client = new Client(`${proto}://${location.hostname}${port}`);
    }
  }

  create(profile: JoinProfile): Promise<Room> {
    return this.client.create("race", profile);
  }

  joinByCode(code: string, profile: JoinProfile): Promise<Room> {
    return this.client.joinById(code.trim().toUpperCase(), profile);
  }
}
