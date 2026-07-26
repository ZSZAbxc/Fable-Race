import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { DEFAULT_SERVER_PORT } from "@fable/shared";
import { RaceRoom } from "./rooms/RaceRoom";

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);

const gameServer = new Server({
  transport: new WebSocketTransport(),
});

gameServer.define("race", RaceRoom);

gameServer.listen(port).then(() => {
  console.log(`[server] Fable Race 服务已启动  ws://localhost:${port}`);
});
