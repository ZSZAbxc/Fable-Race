import RAPIER from "@dimforge/rapier3d-compat";
import type { Room } from "colyseus.js";
import { MSG, TRACKS, getTrack, type ResultsPayload, type StartedPayload } from "@fable/shared";
import { GameSession, PLAYGROUND_ID } from "./core/GameSession";
import { NetClient } from "./net/NetClient";
import { Hud } from "./ui/hud";
import { MenuUI } from "./ui/menu";
import { Settings } from "./ui/settings";
import { audio } from "./audio/AudioSystem";

/**
 * 浏览器要求音频必须由用户手势解锁。用一次性的全局监听覆盖所有入口
 * （菜单按钮、?map= 直连时的第一次按键），解锁后立刻预载资产。
 */
function armAudioUnlock() {
  const arm = () => {
    window.removeEventListener("pointerdown", arm);
    window.removeEventListener("keydown", arm);
    void audio.preload();
    void lockLandscape();
  };
  window.addEventListener("pointerdown", arm, { once: false });
  window.addEventListener("keydown", arm, { once: false });
}

/**
 * 移动端尽量锁横屏。orientation.lock 只在全屏下生效且要求用户激活手势，
 * iOS Safari 完全不支持 —— 全部失败路径静默降级，竖屏下照常可玩，不做拦截。
 */
async function lockLandscape() {
  if (!matchMedia("(pointer: coarse)").matches) return;
  const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
  if (!orientation?.lock) return;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    await orientation.lock("landscape");
  } catch {
    /* 不支持就算了，竖屏时有提示层 */
  }
}

/** 单机模式右上角地图切换链接 */
function buildMapLinks(currentId: string) {
  const items = [
    ...Object.values(TRACKS).map((t) => ({ id: t.id, label: `${t.name} ${"★".repeat(t.difficulty)}` })),
    { id: PLAYGROUND_ID, label: "自由试车场" },
  ];
  document.getElementById("maps")!.innerHTML = items
    .map((it) => `<a href="?map=${it.id}" class="${it.id === currentId ? "active" : ""}">${it.label}</a>`)
    .join("");
}

async function main() {
  await RAPIER.init();
  document.getElementById("loading")?.remove();
  armAudioUnlock();

  const hud = new Hud();
  const menu = new MenuUI();
  let session: GameSession | undefined;

  // 设置浮层：任意界面可开。开着时挂起操控，免得拖滑条的同时车在跑
  const settings = new Settings();
  settings.onToggle = (open) => session?.setPaused(open);
  // 无 session 时（主菜单）不需要处理：下次 launch 时构造函数会读偏好
  settings.onTouchControlsChanged = (on) => session?.setTouchControls(on);

  function launch(mapId: string, netOpts?: { room: Room; startAt: number }) {
    session?.dispose();
    const p = menu.profile();
    session = new GameSession({ mapId, color: p.color, carId: p.carId, hud, net: netOpts });
    // M 键改静音后同步面板控件
    session.onAudioChanged = () => settings.syncFromAudio();
    // 若开着设置就切了地图，新 session 要继承挂起状态
    if (settings.isOpen) session.setPaused(true);
    // 单人才给"返回主界面"；联机退出必须走大厅的离开房间，否则服务端仍留着席位
    hud.setQuitVisible(!netOpts);
    if (!netOpts) buildMapLinks(mapId);
  }

  /** 单人：拆掉会话回主菜单，不刷新页面（复用联机"回大厅"那条已验证的拆卸路径） */
  function quitToMenu() {
    session?.dispose();
    session = undefined;
    hud.setQuitVisible(false);
    hud.reset();
    document.getElementById("maps")!.innerHTML = "";
    menu.showMenu("solo");
  }

  // 带 ?map= 直接进单机（保留快速测试入口）。
  // 这条路径下菜单尚未接线，返回时清掉 query 重载，避免落进空菜单。
  const qMap = new URLSearchParams(location.search).get("map");
  if (qMap) {
    hud.onQuit(() => location.assign(location.pathname));
    launch(qMap);
    return;
  }

  hud.onQuit(quitToMenu);
  menu.showMenu();
  const net = new NetClient();

  menu.onPractice = (mapId) => {
    menu.hideAll();
    launch(mapId);
  };

  menu.onCreate = async () => {
    menu.setBusy(true);
    menu.setError("");
    try {
      enterLobby(await net.create({ ...menu.profile() }));
    } catch (e) {
      menu.setError("创建失败：服务器未启动？(pnpm dev 会同时启动服务端)");
      console.error(e);
    } finally {
      menu.setBusy(false);
    }
  };

  menu.onJoin = async (code) => {
    menu.setBusy(true);
    menu.setError("");
    try {
      enterLobby(await net.joinByCode(code, { ...menu.profile() }));
    } catch (e) {
      menu.setError("加入失败：房间不存在或已满");
      console.error(e);
    } finally {
      menu.setBusy(false);
    }
  };

  function enterLobby(room: Room) {
    menu.showLobby(room.roomId);
    let lastPhase: string = room.state.phase ?? "lobby";

    room.onStateChange(() => {
      const phase: string = room.state.phase ?? "lobby";

      // 结算/比赛 → 回大厅（房主点了"再来一局"）
      if (phase === "lobby" && lastPhase !== "lobby") {
        session?.dispose();
        session = undefined;
        hud.reset();
        document.getElementById("maps")!.innerHTML = "";
        menu.showLobby(room.roomId);
      }
      lastPhase = phase;

      if (phase === "lobby") {
        const players = [...room.state.players.entries()].map(([id, p]: [string, any]) => ({
          id,
          name: p.name,
          color: p.color,
          ready: p.ready,
          carId: p.carId,
        }));
        menu.setLobby(players, room.sessionId, room.state.hostId, room.state.mapId);
      }
    });

    menu.onReady = (r) => room.send(MSG.READY, r);
    menu.onSelectMap = (mapId) => room.send(MSG.SELECT_MAP, mapId);
    menu.onSelectCar = (carId) => room.send(MSG.SELECT_CAR, carId);
    menu.onStart = () => room.send(MSG.START);
    menu.onBackToLobby = () => room.send(MSG.BACK_TO_LOBBY);
    menu.onLeave = () => {
      room.leave();
      location.reload();
    };
    room.onError((code, message) => menu.setError(`连接错误 ${code}: ${message}`));
    room.onLeave(() => {
      if (session) hud.banner("与服务器断开连接", 0);
      else {
        menu.showMenu();
        menu.setError("已断开连接");
      }
    });

    room.onMessage(MSG.STARTED, (payload: StartedPayload) => {
      menu.hideAll();
      launch(payload.mapId, { room, startAt: Date.now() + Math.max(0, payload.startAt - Date.now()) });
    });

    // 服务端结算：冻结本局，弹结算面板
    room.onMessage(MSG.RESULTS, (payload: ResultsPayload) => {
      session?.freeze();
      const trackName = getTrack(room.state.mapId).name;
      menu.showResults(payload.entries, room.sessionId, room.state.hostId === room.sessionId, trackName);
    });
  }
}

main();
