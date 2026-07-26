import { Client, type Room } from "colyseus.js";
import { DEFAULT_SERVER_PORT } from "@fable/shared";

export interface JoinProfile {
  name: string;
  color: string;
  carId?: string;
  mapId?: string;
}

/** 连接封装：开发环境自动指向同主机的 2567 端口 */
export class NetClient {
  readonly client: Client;

  constructor() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // 开发环境(localhost) Colyseus 在 2567，生产环境跟页面同端口（nginx 代理）
    const devPort = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
      ? `:${DEFAULT_SERVER_PORT}`
      : (location.port ? `:${location.port}` : "");
    const endpoint = `${proto}://${location.hostname}${devPort}`;
    this.client = new Client(endpoint);
  }

  create(profile: JoinProfile): Promise<Room> {
    return this.client.create("race", profile);
  }

  joinByCode(code: string, profile: JoinProfile): Promise<Room> {
    return this.client.joinById(code.trim().toUpperCase(), profile);
  }
}
