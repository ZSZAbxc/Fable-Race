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
    const endpoint = location.port
      ? `${proto}://${location.hostname}:${location.port}`
      : `${proto}://${location.hostname}`;
    this.client = new Client(endpoint);
  }

  create(profile: JoinProfile): Promise<Room> {
    return this.client.create("race", profile);
  }

  joinByCode(code: string, profile: JoinProfile): Promise<Room> {
    return this.client.joinById(code.trim().toUpperCase(), profile);
  }
}
