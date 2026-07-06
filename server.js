const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const DEFAULT_HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY_BYTES = 1024 * 128;
const CLIENT_DISCONNECT_GRACE_MS = 90 * 1000;
const EVENT_HEARTBEAT_MS = 15 * 1000;

const appState = {
  rooms: new Map(),
  messages: new Map(),
  clients: new Map(),
  voiceRooms: new Map(),
  screenShares: new Map(),
  musicStates: new Map(),
  disconnectTimers: new Map()
};

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (requestUrl.pathname === "/api/events" && req.method === "GET") {
        handleEventStream(req, res, requestUrl);
        return;
      }

      if (requestUrl.pathname === "/api/bootstrap" && req.method === "GET") {
        sendJson(res, {
          rooms: getRoomSnapshot(),
          servers: getServers(),
          voiceRooms: getVoiceSnapshot(),
          onlineUsers: getOnlineUsers(),
          screenShares: Object.fromEntries(appState.screenShares),
          musicStates: getMusicSnapshot()
        });
        return;
      }

      if (requestUrl.pathname === "/api/messages" && req.method === "GET") {
        const channelId = normalizeId(requestUrl.searchParams.get("channelId"));
        sendJson(res, appState.messages.get(channelId) || []);
        return;
      }

      if (requestUrl.pathname === "/api/messages" && req.method === "POST") {
        const body = await readJson(req);
        const channelId = normalizeId(body.channelId);
        const message = {
          id: crypto.randomUUID(),
          channelId,
          authorId: normalizeId(body.authorId),
          authorName: normalizeDisplayName(body.authorName),
          text: normalizeText(body.text, 4000),
          createdAt: new Date().toISOString()
        };

        if (!channelExists(channelId, "text") || !message.text) {
          sendJson(res, { error: "invalid message" }, 400);
          return;
        }

        const messages = appState.messages.get(channelId) || [];
        messages.push(message);
        appState.messages.set(channelId, messages.slice(-200));
        broadcast("chat-message", message);
        sendJson(res, message, 201);
        return;
      }

      if (requestUrl.pathname === "/api/rooms" && req.method === "POST") {
        const body = await readJson(req);
        const clientId = normalizeId(body.clientId);
        const name = normalizeDisplayName(body.name);
        const roomName = normalizeRoomName(body.roomName);

        if (!clientId || !roomName) {
          sendJson(res, { error: "invalid room request" }, 400);
          return;
        }

        const room = getOrCreateRoom(roomName, name);
        updateClientMetadata(clientId, name, room.id);
        broadcastRooms();
        broadcastPresence();
        sendJson(res, {
          ok: true,
          name,
          room: publicRoom(room),
          server: roomToServer(room)
        }, 201);
        return;
      }

      if (requestUrl.pathname === "/api/presence" && req.method === "POST") {
        const body = await readJson(req);
        updateClientMetadata(
          normalizeId(body.clientId),
          normalizeDisplayName(body.name),
          normalizeId(body.roomId)
        );
        broadcastPresence();
        broadcastRooms();
        sendJson(res, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/voice/join" && req.method === "POST") {
        const body = await readJson(req);
        const clientId = normalizeId(body.clientId);
        const name = normalizeDisplayName(body.name);
        const roomId = normalizeId(body.roomId);

        if (!clientId || !channelExists(roomId, "voice")) {
          sendJson(res, { error: "invalid voice room" }, 400);
          return;
        }

        updateClientMetadata(clientId, name);
        removeClientFromVoiceRooms(clientId);
        const peers = appState.voiceRooms.get(roomId) || new Map();
        peers.set(clientId, { clientId, name, joinedAt: Date.now() });
        appState.voiceRooms.set(roomId, peers);

        const currentPeers = [...peers.values()].filter((peer) => peer.clientId !== clientId);
        broadcastVoiceState();
        broadcastRooms();
        sendJson(res, { ok: true, roomId, peers: currentPeers });
        return;
      }

      if (requestUrl.pathname === "/api/voice/leave" && req.method === "POST") {
        const body = await readJson(req);
        const clientId = normalizeId(body.clientId);
        removeClientFromVoiceRooms(clientId);
        clearScreenShare(clientId);
        broadcastVoiceState();
        broadcastRooms();
        broadcast("screen-state", { clientId, active: false });
        sendJson(res, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/signal" && req.method === "POST") {
        const body = await readJson(req);
        const payload = {
          from: normalizeId(body.from),
          to: normalizeId(body.to),
          roomId: normalizeId(body.roomId),
          description: body.description || null,
          candidate: body.candidate || null
        };

        if (!payload.from || !payload.to || !payload.roomId) {
          sendJson(res, { error: "invalid signal" }, 400);
          return;
        }

        sendToClient(payload.to, "signal", payload);
        sendJson(res, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/screen/state" && req.method === "POST") {
        const body = await readJson(req);
        const payload = {
          clientId: normalizeId(body.clientId),
          name: normalizeDisplayName(body.name),
          roomId: normalizeId(body.roomId),
          active: Boolean(body.active)
        };

        if (!payload.clientId || !payload.roomId) {
          sendJson(res, { error: "invalid screen state" }, 400);
          return;
        }

        if (payload.active) {
          appState.screenShares.set(payload.clientId, payload);
        } else {
          clearScreenShare(payload.clientId);
        }

        broadcast("screen-state", payload);
        sendJson(res, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/music" && req.method === "POST") {
        const body = await readJson(req);
        const payload = {
          clientId: normalizeId(body.clientId),
          name: normalizeDisplayName(body.name),
          roomId: normalizeId(body.roomId),
          channelId: normalizeId(body.channelId),
          text: normalizeText(body.text, 600)
        };

        if (!payload.clientId || !appState.rooms.has(payload.roomId) || !channelExists(payload.channelId, "text")) {
          sendJson(res, { error: "invalid music command" }, 400);
          return;
        }

        const result = handleMusicCommand(payload);
        sendJson(res, result, result.ok ? 200 : 400);
        return;
      }

      serveStatic(req, res, requestUrl);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, { error: "internal server error" }, 500);
      } else {
        res.end();
      }
    }
  });
}

function handleEventStream(req, res, requestUrl) {
  const clientId = normalizeId(requestUrl.searchParams.get("clientId"));
  const name = normalizeDisplayName(requestUrl.searchParams.get("name"));
  const roomId = normalizeId(requestUrl.searchParams.get("roomId"));

  if (!clientId) {
    sendJson(res, { error: "missing client id" }, 400);
    return;
  }

  const connectionId = crypto.randomUUID();
  clearClientDisconnectTimer(clientId);
  const previous = appState.clients.get(clientId);
  if (previous?.res && !previous.res.destroyed) {
    previous.res.end();
  }

  req.socket?.setTimeout?.(0);
  req.socket?.setKeepAlive?.(true);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 3000\n: connected\n\n");

  appState.clients.set(clientId, {
    clientId,
    connectionId,
    name,
    roomId,
    res,
    connectedAt: Date.now(),
    lastSeen: Date.now()
  });

  sendToClient(clientId, "hello", {
    clientId,
    rooms: getRoomSnapshot(),
    servers: getServers(),
    voiceRooms: getVoiceSnapshot(),
    onlineUsers: getOnlineUsers(),
    musicStates: getMusicSnapshot()
  });
  broadcastPresence();
  broadcastRooms();

  const heartbeat = setInterval(() => {
    if (res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`event: ping\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
  }, EVENT_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    const current = appState.clients.get(clientId);
    if (current?.connectionId === connectionId) {
      current.res = null;
      current.disconnectedAt = Date.now();
      scheduleClientDisconnectCleanup(clientId, connectionId);
    }
  });
}

function scheduleClientDisconnectCleanup(clientId, connectionId) {
  clearClientDisconnectTimer(clientId);
  const timer = setTimeout(() => {
    const current = appState.clients.get(clientId);
    const isReconnected = current?.res && !current.res.destroyed;
    if (!current || current.connectionId !== connectionId || isReconnected) {
      return;
    }

    appState.clients.delete(clientId);
    appState.disconnectTimers.delete(clientId);
    removeClientFromVoiceRooms(clientId);
    clearScreenShare(clientId);
    broadcastPresence();
    broadcastVoiceState();
    broadcastRooms();
    broadcast("screen-state", { clientId, active: false });
  }, CLIENT_DISCONNECT_GRACE_MS);
  appState.disconnectTimers.set(clientId, timer);
}

function clearClientDisconnectTimer(clientId) {
  const timer = appState.disconnectTimers.get(clientId);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  appState.disconnectTimers.delete(clientId);
}

function updateClientMetadata(clientId, name, roomId = "") {
  if (!clientId) {
    return;
  }
  const current = appState.clients.get(clientId);
  if (current) {
    current.name = name;
    current.roomId = roomId || current.roomId || "";
    current.lastSeen = Date.now();
  } else {
    appState.clients.set(clientId, {
      clientId,
      connectionId: null,
      name,
      roomId,
      res: null,
      connectedAt: Date.now(),
      lastSeen: Date.now()
    });
  }
}

function broadcastPresence() {
  broadcast("presence", { onlineUsers: getOnlineUsers() });
}

function broadcastVoiceState() {
  broadcast("voice-state", { rooms: getVoiceSnapshot() });
}

function broadcastRooms() {
  broadcast("rooms", { rooms: getRoomSnapshot() });
}

function broadcastMusicState(roomId) {
  const state = appState.musicStates.get(roomId) || createStoppedMusicState(roomId);
  broadcast("music-state", publicMusicState(state), (client) => client.roomId === roomId);
}

function broadcast(event, payload, predicate = () => true) {
  for (const client of appState.clients.values()) {
    if (client.res && !client.res.destroyed && predicate(client)) {
      writeEvent(client.res, event, payload);
    }
  }
}

function sendToClient(clientId, event, payload) {
  const client = appState.clients.get(clientId);
  if (client?.res && !client.res.destroyed) {
    writeEvent(client.res, event, payload);
  }
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getOnlineUsers() {
  return [...appState.clients.values()]
    .filter((client) => client.res && !client.res.destroyed)
    .map((client) => ({
      clientId: client.clientId,
      name: client.name,
      roomId: client.roomId,
      connectedAt: client.connectedAt
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getServers() {
  return [...appState.rooms.values()].map(roomToServer);
}

function getRoomSnapshot() {
  return [...appState.rooms.values()]
    .map(publicRoom)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getOrCreateRoom(roomName, createdBy) {
  const id = createRoomId(roomName);
  const existing = appState.rooms.get(id);
  if (existing) {
    existing.lastOpenedAt = new Date().toISOString();
    return existing;
  }

  const now = new Date().toISOString();
  const room = {
    id,
    name: roomName,
    serverId: `server-${id}`,
    textChannelId: `text-${id}`,
    voiceChannelId: `voice-${id}`,
    createdAt: now,
    lastOpenedAt: now,
    createdBy
  };
  appState.rooms.set(id, room);
  appState.messages.set(room.textChannelId, [
    {
      id: crypto.randomUUID(),
      channelId: room.textChannelId,
      authorId: "system",
      authorName: "schibb's mic",
      text: `${room.name} is open.`,
      createdAt: now
    }
  ]);
  return room;
}

function publicRoom(room) {
  const voicePeers = appState.voiceRooms.get(room.voiceChannelId);
  const memberCount = getOnlineUsers().filter((user) => user.roomId === room.id).length;
  return {
    id: room.id,
    name: room.name,
    serverId: room.serverId,
    textChannelId: room.textChannelId,
    voiceChannelId: room.voiceChannelId,
    createdAt: room.createdAt,
    lastOpenedAt: room.lastOpenedAt,
    memberCount,
    voiceCount: voicePeers?.size || 0
  };
}

function roomToServer(room) {
  return {
    id: room.serverId,
    roomId: room.id,
    name: room.name,
    initials: getInitials(room.name),
    sections: [
      {
        id: `${room.id}-text`,
        name: "text channel",
        type: "text",
        channels: [
          {
            id: room.textChannelId,
            name: room.name,
            topic: `room chat for ${room.name}`
          }
        ]
      },
      {
        id: `${room.id}-voice`,
        name: "voice room",
        type: "voice",
        channels: [
          {
            id: room.voiceChannelId,
            name: room.name,
            bitrate: "opus + webrtc media"
          }
        ]
      }
    ]
  };
}

function getVoiceSnapshot() {
  const snapshot = {};
  for (const [roomId, peers] of appState.voiceRooms.entries()) {
    snapshot[roomId] = [...peers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }
  return snapshot;
}

function getMusicSnapshot() {
  return Object.fromEntries(
    [...appState.musicStates.entries()].map(([roomId, state]) => [roomId, publicMusicState(state)])
  );
}

function handleMusicCommand(payload) {
  const parsed = parseMusicCommand(payload.text);
  if (!parsed) {
    return { ok: false, error: "invalid music command" };
  }

  const currentState = appState.musicStates.get(payload.roomId);
  if (parsed.action === "help") {
    addBotMessage(payload.channelId, "music commands: !music <youtube link>, !music pause, !music resume, !music stop.");
    return { ok: true, state: currentState ? publicMusicState(currentState) : createStoppedMusicState(payload.roomId) };
  }

  if (parsed.action === "play") {
    if (parsed.url) {
      const videoId = extractYouTubeVideoId(parsed.url);
      if (!videoId) {
        addBotMessage(payload.channelId, "send a valid youtube link.");
        return { ok: false, error: "invalid youtube link" };
      }

      const state = {
        roomId: payload.roomId,
        active: true,
        status: "playing",
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        position: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        requestedBy: payload.name
      };
      appState.musicStates.set(payload.roomId, state);
      broadcastMusicState(payload.roomId);
      addBotMessage(payload.channelId, `${payload.name} started music.`);
      return { ok: true, state: publicMusicState(state) };
    }

    if (!currentState?.active) {
      addBotMessage(payload.channelId, "send a youtube link first.");
      return { ok: false, error: "missing youtube link" };
    }

    return resumeMusic(payload, currentState);
  }

  if (parsed.action === "pause") {
    if (!currentState?.active) {
      addBotMessage(payload.channelId, "music is not playing.");
      return { ok: false, error: "music is not playing" };
    }
    const state = {
      ...currentState,
      status: "paused",
      position: getMusicPosition(currentState),
      updatedAt: Date.now()
    };
    appState.musicStates.set(payload.roomId, state);
    broadcastMusicState(payload.roomId);
    addBotMessage(payload.channelId, "music paused.");
    return { ok: true, state: publicMusicState(state) };
  }

  if (parsed.action === "resume") {
    if (!currentState?.active) {
      addBotMessage(payload.channelId, "music is not loaded.");
      return { ok: false, error: "music is not loaded" };
    }
    return resumeMusic(payload, currentState);
  }

  if (parsed.action === "stop") {
    const state = createStoppedMusicState(payload.roomId);
    appState.musicStates.set(payload.roomId, state);
    broadcastMusicState(payload.roomId);
    addBotMessage(payload.channelId, "music stopped.");
    return { ok: true, state: publicMusicState(state) };
  }

  addBotMessage(payload.channelId, "music commands: !music <youtube link>, !music pause, !music resume, !music stop.");
  return { ok: true, state: currentState ? publicMusicState(currentState) : createStoppedMusicState(payload.roomId) };
}

function resumeMusic(payload, currentState) {
  const state = {
    ...currentState,
    active: true,
    status: "playing",
    position: currentState.status === "paused" ? currentState.position || 0 : getMusicPosition(currentState),
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  appState.musicStates.set(payload.roomId, state);
  broadcastMusicState(payload.roomId);
  addBotMessage(payload.channelId, "music resumed.");
  return { ok: true, state: publicMusicState(state) };
}

function parseMusicCommand(text) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() !== "!music") {
    return null;
  }

  const args = parts.slice(1);
  if (args.length === 0) {
    return { action: "help" };
  }

  const first = args[0].toLowerCase();
  if (first === "pause") {
    return { action: "pause" };
  }
  if (first === "resume" || first === "unpause") {
    return { action: "resume" };
  }
  if (first === "stop" || first === "clear") {
    return { action: "stop" };
  }
  if (first === "help") {
    return { action: "help" };
  }
  if (first === "play") {
    return { action: "play", url: args.slice(1).join(" ") };
  }
  return { action: "play", url: args.join(" ") };
}

function extractYouTubeVideoId(value) {
  const text = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(text)) {
    return text;
  }

  try {
    const parsed = new URL(text);
    const host = parsed.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") {
      return normalizeYouTubeId(parsed.pathname.split("/").filter(Boolean)[0]);
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const watchId = normalizeYouTubeId(parsed.searchParams.get("v"));
      if (watchId) {
        return watchId;
      }
      const parts = parsed.pathname.split("/").filter(Boolean);
      const markerIndex = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
      if (markerIndex !== -1) {
        return normalizeYouTubeId(parts[markerIndex + 1]);
      }
    }
  } catch (error) {
    return "";
  }
  return "";
}

function normalizeYouTubeId(value) {
  const match = String(value || "").match(/^[a-zA-Z0-9_-]{11}/);
  return match ? match[0] : "";
}

function createStoppedMusicState(roomId) {
  return {
    roomId,
    active: false,
    status: "stopped",
    videoId: "",
    url: "",
    position: 0,
    startedAt: 0,
    updatedAt: Date.now(),
    requestedBy: "music bot"
  };
}

function publicMusicState(state) {
  return {
    ...state,
    serverTime: Date.now()
  };
}

function getMusicPosition(state) {
  if (!state?.active) {
    return 0;
  }
  const base = Number(state.position || 0);
  if (state.status !== "playing") {
    return base;
  }
  return Math.max(0, base + (Date.now() - Number(state.startedAt || Date.now())) / 1000);
}

function addBotMessage(channelId, text) {
  const message = {
    id: crypto.randomUUID(),
    channelId,
    authorId: "music-bot",
    authorName: "music bot",
    text,
    createdAt: new Date().toISOString()
  };
  const messages = appState.messages.get(channelId) || [];
  messages.push(message);
  appState.messages.set(channelId, messages.slice(-200));
  broadcast("chat-message", message);
  return message;
}

function removeClientFromVoiceRooms(clientId) {
  if (!clientId) {
    return;
  }
  clearClientDisconnectTimer(clientId);
  for (const [roomId, peers] of appState.voiceRooms.entries()) {
    peers.delete(clientId);
    if (peers.size === 0) {
      appState.voiceRooms.delete(roomId);
    }
  }
}

function clearScreenShare(clientId) {
  if (clientId) {
    appState.screenShares.delete(clientId);
  }
}

function channelExists(channelId, type) {
  return getServers().some((server) =>
    server.sections.some((section) =>
      section.type === type && section.channels.some((channel) => channel.id === channelId)
    )
  );
}

function createRoomId(roomName) {
  const slug = roomName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `room-${slug || crypto.randomUUID().slice(0, 8)}`;
}

function getInitials(name) {
  return String(name || "sm")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLowerCase() || "sm";
}

function serveStatic(req, res, requestUrl) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, { error: "not found" }, 404);
    return;
  }

  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const decodedPath = decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, { error: "forbidden" }, 403);
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          sendJson(res, { error: "not found" }, 404);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fallback);
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": getMimeType(filePath),
      "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600"
    });
    res.end(req.method === "HEAD" ? undefined : content);
  });
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8"
  }[extension] || "application/octet-stream";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  res.end(JSON.stringify(payload));
}

function normalizeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9:_-]/g, "")
    .slice(0, 96);
}

function normalizeDisplayName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 32) || "guest";
}

function normalizeRoomName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 48);
}

function normalizeText(value, maxLength) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function startServer(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host || DEFAULT_HOST;
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const displayHost =
        address.address === "::" || address.address === "0.0.0.0"
          ? "127.0.0.1"
          : address.address;
      const url = `http://${displayHost}:${address.port}`;
      if (!options.silent) {
        console.log(`schibb's mic is running at ${url} (${address.address})`);
      }
      resolve({ server, url, port: address.port });
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startServer };
