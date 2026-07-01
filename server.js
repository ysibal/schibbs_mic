const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const DEFAULT_HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY_BYTES = 1024 * 128;

const appState = {
  rooms: new Map(),
  messages: new Map(),
  clients: new Map(),
  voiceRooms: new Map(),
  screenShares: new Map()
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
          screenShares: Object.fromEntries(appState.screenShares)
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
          sendJson(res, { error: "Invalid message" }, 400);
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
          sendJson(res, { error: "Invalid room request" }, 400);
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
          sendJson(res, { error: "Invalid voice room" }, 400);
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
          sendJson(res, { error: "Invalid signal" }, 400);
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
          sendJson(res, { error: "Invalid screen state" }, 400);
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

      serveStatic(req, res, requestUrl);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, { error: "Internal server error" }, 500);
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
    sendJson(res, { error: "Missing clientId" }, 400);
    return;
  }

  const connectionId = crypto.randomUUID();
  const previous = appState.clients.get(clientId);
  if (previous?.res && !previous.res.destroyed) {
    previous.res.end();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

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
    onlineUsers: getOnlineUsers()
  });
  broadcastPresence();
  broadcastRooms();

  const heartbeat = setInterval(() => {
    if (res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`event: ping\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const current = appState.clients.get(clientId);
    if (current?.connectionId === connectionId) {
      appState.clients.delete(clientId);
      removeClientFromVoiceRooms(clientId);
      clearScreenShare(clientId);
      broadcastPresence();
      broadcastVoiceState();
      broadcastRooms();
      broadcast("screen-state", { clientId, active: false });
    }
  });
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
      text: `Welcome to ${room.name}. Use the room chat, join voice, turn on camera, or share your screen.`,
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
        name: "Text Channel",
        type: "text",
        channels: [
          {
            id: room.textChannelId,
            name: room.name,
            topic: `Room chat for ${room.name}`
          }
        ]
      },
      {
        id: `${room.id}-voice`,
        name: "Voice Room",
        type: "voice",
        channels: [
          {
            id: room.voiceChannelId,
            name: room.name,
            bitrate: "Opus + WebRTC media"
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

function removeClientFromVoiceRooms(clientId) {
  if (!clientId) {
    return;
  }
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
  return String(name || "SM")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "SM";
}

function serveStatic(req, res, requestUrl) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, { error: "Not found" }, 404);
    return;
  }

  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const decodedPath = decodeURIComponent(pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, { error: "Forbidden" }, 403);
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          sendJson(res, { error: "Not found" }, 404);
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
        reject(new Error("Request body too large"));
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
  return text.slice(0, 32) || "Guest";
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
