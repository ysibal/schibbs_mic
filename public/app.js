const app = {
  clientId: getClientId(),
  name: "",
  rooms: [],
  servers: [],
  currentRoomId: "",
  currentServerId: "",
  currentChannelId: "",
  currentVoiceId: "",
  messages: new Map(),
  onlineUsers: [],
  voiceRooms: {},
  screenShares: {},
  eventSource: null,
  lobbyPollTimer: null,
  chatOpen: false,
  micStream: null,
  cameraStream: null,
  screenStream: null,
  peers: new Map(),
  remoteMedia: new Map(),
  muted: false,
  devices: {
    microphones: [],
    speakers: [],
    cameras: []
  },
  selectedMicrophoneId: "",
  selectedSpeakerId: "",
  selectedCameraId: "",
  micMonitor: null,
  micLevel: 0,
  qualityTimer: null,
  lastStats: new Map(),
  qualitySnapshot: {
    qualityText: "quality idle",
    qualityTone: "idle",
    networkText: "network idle",
    networkTone: "idle"
  }
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ]
};

const colorPalettes = new Set(["brown", "rose", "olive", "ocean", "graphite"]);

const dom = {
  landingScreen: document.querySelector("#landingScreen"),
  appShell: document.querySelector("#appShell"),
  roomEntryForm: document.querySelector("#roomEntryForm"),
  entryName: document.querySelector("#entryName"),
  entryRoom: document.querySelector("#entryRoom"),
  activeRoomsList: document.querySelector("#activeRoomsList"),
  paletteButtons: [...document.querySelectorAll("[data-palette]")],
  themeMeta: document.querySelector("meta[name=\"theme-color\"]"),
  themeToggle: document.querySelector("#themeToggle"),
  themeToggleApp: document.querySelector("#themeToggleApp"),
  mainPane: document.querySelector(".main-pane"),
  channelList: document.querySelector("#channelList"),
  workspaceName: document.querySelector("#workspaceName"),
  connectionStatus: document.querySelector("#connectionStatus"),
  profileAvatar: document.querySelector("#profileAvatar"),
  profileName: document.querySelector("#profileName"),
  profileStatus: document.querySelector("#profileStatus"),
  editProfileButton: document.querySelector("#editProfileButton"),
  chatTitle: document.querySelector("#chatTitle"),
  chatTopic: document.querySelector("#chatTopic"),
  chatTabButton: document.querySelector("#chatTabButton"),
  closeChatButton: document.querySelector("#closeChatButton"),
  chatPanel: document.querySelector("#chatPanel"),
  messageList: document.querySelector("#messageList"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  voiceTitle: document.querySelector("#voiceTitle"),
  stageGrid: document.querySelector("#stageGrid"),
  muteButton: document.querySelector("#muteButton"),
  cameraButton: document.querySelector("#cameraButton"),
  shareButton: document.querySelector("#shareButton"),
  leaveVoiceButton: document.querySelector("#leaveVoiceButton"),
  microphoneSelect: document.querySelector("#microphoneSelect"),
  speakerSelect: document.querySelector("#speakerSelect"),
  cameraSelect: document.querySelector("#cameraSelect"),
  micStatus: document.querySelector("#micStatus"),
  screenStatus: document.querySelector("#screenStatus"),
  qualityStatus: document.querySelector("#qualityStatus"),
  networkStatus: document.querySelector("#networkStatus"),
  memberCount: document.querySelector("#memberCount"),
  memberList: document.querySelector("#memberList"),
  toast: document.querySelector("#toast")
};

init();

async function init() {
  initTheme();
  bindEvents();
  await bootstrap();
  await refreshDevices();
  registerServiceWorker();
  showLanding();
  renderLandingRooms();
}

function bindEvents() {
  dom.roomEntryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await enterRoom(dom.entryRoom.value);
  });

  dom.editProfileButton.addEventListener("click", returnToLobby);
  dom.themeToggle.addEventListener("click", toggleTheme);
  dom.themeToggleApp.addEventListener("click", toggleTheme);
  for (const button of dom.paletteButtons) {
    button.addEventListener("click", () => {
      applyPalette(button.dataset.palette);
    });
  }
  dom.chatTabButton.addEventListener("click", () => {
    setChatOpen(!app.chatOpen);
  });
  dom.closeChatButton.addEventListener("click", () => {
    setChatOpen(false);
  });

  dom.messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
  });

  dom.muteButton.addEventListener("click", () => {
    app.muted = !app.muted;
    setMicEnabled(!app.muted);
    renderVoiceControls();
  });

  dom.cameraButton.addEventListener("click", async () => {
    if (app.cameraStream) {
      stopCamera();
    } else {
      await startCamera();
    }
  });

  dom.shareButton.addEventListener("click", async () => {
    if (app.screenStream) {
      await stopScreenShare();
    } else {
      await startScreenShare();
    }
  });

  dom.microphoneSelect.addEventListener("change", async () => {
    await selectMicrophone(dom.microphoneSelect.value);
  });

  dom.speakerSelect.addEventListener("change", async () => {
    await selectSpeaker(dom.speakerSelect.value);
  });

  dom.cameraSelect.addEventListener("change", async () => {
    await selectCamera(dom.cameraSelect.value);
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
  }

  dom.leaveVoiceButton.addEventListener("click", () => leaveVoice());

  window.addEventListener("beforeunload", () => {
    if (app.currentVoiceId) {
      navigator.sendBeacon(
        "/api/voice/leave",
        JSON.stringify({ clientId: app.clientId })
      );
    }
  });
}

async function bootstrap() {
  const data = await fetchJson("/api/bootstrap");
  app.rooms = data.rooms || [];
  app.servers = data.servers || [];
  app.voiceRooms = data.voiceRooms || {};
  app.onlineUsers = data.onlineUsers || [];
  app.screenShares = data.screenShares || {};
}

async function enterRoom(roomName) {
  const name = dom.entryName.value.trim();
  const requestedRoom = String(roomName || "").trim();

  if (!name || !requestedRoom) {
    showToast("name and room are required.");
    return;
  }

  const response = await postJson("/api/rooms", {
    clientId: app.clientId,
    name,
    roomName: requestedRoom
  });

  app.name = response.name || name;
  app.currentRoomId = response.room.id;
  app.rooms = mergeRoom(app.rooms, response.room);
  app.servers = [response.server];
  app.currentServerId = response.server.id;
  app.currentChannelId = response.room.textChannelId;
  app.currentVoiceId = "";
  app.remoteMedia.clear();
  app.peers.clear();
  setChatOpen(false);
  stopLobbyPolling();

  await loadMessages(app.currentChannelId);
  connectEvents();
  await updatePresence();
  dom.landingScreen.hidden = true;
  dom.appShell.hidden = false;
  render();
}

async function returnToLobby() {
  await leaveVoice({ keepNoticeQuiet: true });
  if (app.eventSource) {
    app.eventSource.close();
    app.eventSource = null;
  }
  app.currentRoomId = "";
  app.currentServerId = "";
  app.currentChannelId = "";
  app.currentVoiceId = "";
  app.servers = [];
  app.onlineUsers = [];
  setChatOpen(false);
  dom.entryName.value = "";
  dom.entryRoom.value = "";
  setConnectionStatus("offline", false);
  await bootstrap();
  showLanding();
  renderLandingRooms();
}

function showLanding() {
  dom.appShell.hidden = true;
  dom.landingScreen.hidden = false;
  startLobbyPolling();
  setTimeout(() => dom.entryName.focus(), 0);
}

function startLobbyPolling() {
  stopLobbyPolling();
  app.lobbyPollTimer = setInterval(refreshLobbyRooms, 4000);
}

function stopLobbyPolling() {
  if (app.lobbyPollTimer) {
    clearInterval(app.lobbyPollTimer);
    app.lobbyPollTimer = null;
  }
}

async function refreshLobbyRooms() {
  if (dom.landingScreen.hidden) {
    return;
  }
  try {
    const data = await fetchJson("/api/bootstrap");
    app.rooms = data.rooms || [];
    renderLandingRooms();
  } catch (error) {
    console.warn("could not refresh rooms", error);
  }
}

function renderLandingRooms() {
  dom.activeRoomsList.replaceChildren();

  if (app.rooms.length === 0) {
    const empty = document.createElement("p");
    empty.className = "active-rooms-empty";
    empty.textContent = "no active rooms.";
    dom.activeRoomsList.append(empty);
    return;
  }

  for (const room of app.rooms) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "active-room-button";
    button.addEventListener("click", () => {
      dom.entryRoom.value = room.name;
      if (dom.entryName.value.trim()) {
        enterRoom(room.name);
      } else {
        dom.entryName.focus();
      }
    });

    const avatar = document.createElement("span");
    avatar.className = "active-room-avatar";
    avatar.textContent = getInitials(room.name);

    const copy = document.createElement("span");
    copy.className = "active-room-copy";

    const title = document.createElement("strong");
    title.textContent = room.name;
    const meta = document.createElement("span");
    meta.textContent = `${room.memberCount || 0} users · ${room.voiceCount || 0} in voice`;
    copy.append(title, meta);

    const action = document.createElement("span");
    action.className = "active-room-action";
    action.textContent = "join";

    button.append(avatar, copy, action);
    dom.activeRoomsList.append(button);
  }
}

function mergeRoom(rooms, room) {
  const next = rooms.filter((item) => item.id !== room.id);
  next.push(room);
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

function initTheme() {
  const savedTheme = localStorage.getItem("schibbs-mic-theme");
  const theme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
  const savedPalette = localStorage.getItem("schibbs-mic-palette");
  const palette = colorPalettes.has(savedPalette) ? savedPalette : "brown";
  applyTheme(theme);
  applyPalette(palette);
}

function toggleTheme() {
  const currentTheme = document.documentElement.dataset.theme || "dark";
  applyTheme(currentTheme === "dark" ? "light" : "dark");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("schibbs-mic-theme", theme);
  const nextLabel = theme === "dark" ? "light" : "dark";
  for (const button of [dom.themeToggle, dom.themeToggleApp]) {
    if (!button) {
      continue;
    }
    const label = button.querySelector("span:last-child");
    if (label) {
      label.textContent = nextLabel;
    }
    button.title = `switch to ${nextLabel} mode`;
  }
  updateThemeColor();
}

function applyPalette(palette) {
  const nextPalette = colorPalettes.has(palette) ? palette : "brown";
  document.documentElement.dataset.palette = nextPalette;
  localStorage.setItem("schibbs-mic-palette", nextPalette);
  for (const button of dom.paletteButtons) {
    const isActive = button.dataset.palette === nextPalette;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
  updateThemeColor();
}

function updateThemeColor() {
  if (!dom.themeMeta) {
    return;
  }
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) {
    dom.themeMeta.setAttribute("content", bg);
  }
}

function connectEvents() {
  if (app.eventSource) {
    app.eventSource.close();
  }

  const params = new URLSearchParams({
    clientId: app.clientId,
    name: app.name,
    roomId: app.currentRoomId
  });
  const source = new EventSource(`/api/events?${params.toString()}`);
  app.eventSource = source;
  setConnectionStatus("connecting", false);

  source.addEventListener("open", () => {
    setConnectionStatus("live", true);
  });

  source.addEventListener("hello", (event) => {
    const data = parseEvent(event);
    app.rooms = data.rooms || app.rooms;
    app.voiceRooms = data.voiceRooms || {};
    app.onlineUsers = data.onlineUsers || [];
    renderLandingRooms();
    renderMembers();
    renderChannels();
    renderVoiceStage();
  });

  source.addEventListener("presence", (event) => {
    app.onlineUsers = parseEvent(event).onlineUsers || [];
    renderMembers();
  });

  source.addEventListener("rooms", (event) => {
    app.rooms = parseEvent(event).rooms || [];
    renderLandingRooms();
  });

  source.addEventListener("voice-state", (event) => {
    app.voiceRooms = parseEvent(event).rooms || {};
    syncPeerConnections();
    renderChannels();
    renderVoiceStage();
  });

  source.addEventListener("chat-message", (event) => {
    const message = parseEvent(event);
    const messages = app.messages.get(message.channelId) || [];
    app.messages.set(message.channelId, [...messages, message].slice(-200));
    if (message.channelId === app.currentChannelId) {
      renderMessages();
    }
  });

  source.addEventListener("signal", (event) => {
    handleSignal(parseEvent(event));
  });

  source.addEventListener("screen-state", (event) => {
    const payload = parseEvent(event);
    if (payload.active) {
      app.screenShares[payload.clientId] = payload;
    } else {
      delete app.screenShares[payload.clientId];
    }
    renderVoiceStage();
  });

  source.addEventListener("error", () => {
    setConnectionStatus("reconnecting", false);
  });
}

async function updatePresence() {
  await postJson("/api/presence", {
    clientId: app.clientId,
    name: app.name,
    roomId: app.currentRoomId
  });
}

async function sendMessage() {
  const text = dom.messageInput.value.trim();
  if (!text || !app.currentChannelId) {
    return;
  }

  dom.messageInput.value = "";
  await postJson("/api/messages", {
    channelId: app.currentChannelId,
    authorId: app.clientId,
    authorName: app.name,
    text
  });
}

async function loadMessages(channelId) {
  const messages = await fetchJson(`/api/messages?channelId=${encodeURIComponent(channelId)}`);
  app.messages.set(channelId, messages);
  renderMessages();
}

async function joinVoice(roomId) {
  if (app.currentVoiceId === roomId) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("voice requires a browser with microphone support.");
    return;
  }

  if (app.currentVoiceId) {
    await leaveVoice({ keepNoticeQuiet: true });
  }

  try {
    app.micStream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraints(),
      video: false
    });
  } catch (error) {
    showToast("microphone permission was not granted.");
    return;
  }

  app.currentVoiceId = roomId;
  app.muted = false;
  setMicEnabled(true);
  startMicMonitor();
  startQualityMonitoring();
  await refreshDevices();
  renderVoiceControls();
  renderVoiceStage();

  try {
    const response = await postJson("/api/voice/join", {
      clientId: app.clientId,
      name: app.name,
      roomId
    });
    app.voiceRooms[roomId] = [
      ...(response.peers || []),
      { clientId: app.clientId, name: app.name, joinedAt: Date.now() }
    ];
    await syncPeerConnections();
    render();
  } catch (error) {
    stopQualityMonitoring();
    stopMicMonitor();
    stopStream(app.micStream);
    app.micStream = null;
    app.currentVoiceId = "";
    showToast("could not join the voice room.");
    render();
  }
}

async function leaveVoice(options = {}) {
  const wasInVoice = Boolean(app.currentVoiceId);
  const previousRoomId = app.currentVoiceId;

  if (app.screenStream) {
    await stopScreenShare({ notifyServer: false });
  }
  if (app.cameraStream) {
    stopCamera();
  }

  stopQualityMonitoring();
  stopMicMonitor();

  for (const peer of app.peers.values()) {
    peer.pc.close();
  }
  app.peers.clear();
  app.remoteMedia.clear();
  stopStream(app.micStream);
  app.micStream = null;
  app.currentVoiceId = "";
  app.muted = false;

  if (wasInVoice) {
    await postJson("/api/voice/leave", { clientId: app.clientId, roomId: previousRoomId });
  }

  if (wasInVoice && !options.keepNoticeQuiet) {
    showToast("left voice room.");
  }
  render();
}

async function startCamera() {
  if (!app.currentVoiceId) {
    showToast("join a voice room before turning on your camera.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("camera requires a browser with camera support.");
    return;
  }

  try {
    app.cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: getCameraConstraints()
    });
  } catch (error) {
    showToast("camera permission was not granted.");
    return;
  }

  for (const track of app.cameraStream.getVideoTracks()) {
    track.contentHint = "motion";
    track.addEventListener("ended", () => {
      stopCamera();
    });
  }

  for (const peer of app.peers.values()) {
    addCameraTracks(peer.pc);
  }

  await refreshDevices();
  renderProfile();
  renderVoiceControls();
  renderVoiceStage();
}

function stopCamera() {
  const stream = app.cameraStream;
  if (!stream) {
    return;
  }

  const tracks = new Set(stream.getTracks());
  for (const peer of app.peers.values()) {
    for (const sender of peer.pc.getSenders()) {
      if (sender.track && tracks.has(sender.track)) {
        peer.pc.removeTrack(sender);
      }
    }
  }

  stopStream(stream);
  app.cameraStream = null;
  renderProfile();
  renderVoiceControls();
  renderVoiceStage();
}

async function startScreenShare() {
  if (!app.currentVoiceId) {
    showToast("join a voice room before sharing your screen.");
    return;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast("screen sharing is not supported in this browser.");
    return;
  }

  try {
    app.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: 1920 },
        height: { max: 1080 },
        frameRate: { max: 60 }
      },
      audio: false
    });
  } catch (error) {
    showToast(getScreenShareErrorMessage(error));
    return;
  }

  const [screenTrack] = app.screenStream.getVideoTracks();
  if (screenTrack) {
    screenTrack.contentHint = "detail";
    screenTrack.addEventListener("ended", () => {
      stopScreenShare();
    });
  }

  for (const peer of app.peers.values()) {
    addScreenTracks(peer.pc);
  }

  await postJson("/api/screen/state", {
    clientId: app.clientId,
    name: app.name,
    roomId: app.currentVoiceId,
    active: true
  });
  showToast("screen sharing started.");
  renderVoiceControls();
  renderCallIndicators();
  renderVoiceStage();
}

async function stopScreenShare(options = {}) {
  const notifyServer = options.notifyServer !== false;
  const stream = app.screenStream;
  if (!stream) {
    return;
  }

  const tracks = new Set(stream.getTracks());
  for (const peer of app.peers.values()) {
    for (const sender of peer.pc.getSenders()) {
      if (sender.track && tracks.has(sender.track)) {
        peer.pc.removeTrack(sender);
      }
    }
  }

  stopStream(stream);
  app.screenStream = null;

  if (notifyServer && app.currentVoiceId) {
    await postJson("/api/screen/state", {
      clientId: app.clientId,
      name: app.name,
      roomId: app.currentVoiceId,
      active: false
    });
  }

  renderVoiceControls();
  renderCallIndicators();
  renderVoiceStage();
}

async function syncPeerConnections() {
  if (!app.currentVoiceId || !app.micStream) {
    return;
  }

  const peers = getCurrentVoicePeers().filter((peer) => peer.clientId !== app.clientId);
  const wantedPeerIds = new Set(peers.map((peer) => peer.clientId));

  for (const peer of peers) {
    await ensurePeer(peer.clientId);
  }

  for (const [peerId, peer] of app.peers.entries()) {
    if (!wantedPeerIds.has(peerId)) {
      peer.pc.close();
      app.peers.delete(peerId);
      app.remoteMedia.delete(peerId);
    }
  }
}

async function ensurePeer(peerId) {
  if (!app.currentVoiceId) {
    return null;
  }

  if (app.peers.has(peerId)) {
    const existing = app.peers.get(peerId);
    addLocalTracks(existing.pc);
    return existing;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  const peer = {
    peerId,
    pc,
    polite: app.clientId > peerId,
    makingOffer: false,
    ignoreOffer: false
  };
  app.peers.set(peerId, peer);

  pc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) {
      sendSignal(peerId, { candidate });
    }
  });

  pc.addEventListener("track", ({ track, streams }) => {
    attachRemoteTrack(peerId, track, streams);
  });

  pc.addEventListener("connectionstatechange", () => {
    sampleConnectionQuality();
    renderVoiceStage();
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    sampleConnectionQuality();
  });

  pc.addEventListener("negotiationneeded", async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      await sendSignal(peerId, { description: pc.localDescription });
    } catch (error) {
      console.warn("negotiation failed", error);
    } finally {
      peer.makingOffer = false;
    }
  });

  addLocalTracks(pc);
  renderVoiceStage();
  return peer;
}

function addLocalTracks(pc) {
  if (app.micStream) {
    for (const track of app.micStream.getTracks()) {
      addTrackOnce(pc, track, app.micStream);
    }
  }
  addCameraTracks(pc);
  addScreenTracks(pc);
}

function addCameraTracks(pc) {
  if (!app.cameraStream) {
    return;
  }
  for (const track of app.cameraStream.getTracks()) {
    addTrackOnce(pc, track, app.cameraStream);
  }
}

function addScreenTracks(pc) {
  if (!app.screenStream) {
    return;
  }
  for (const track of app.screenStream.getTracks()) {
    addTrackOnce(pc, track, app.screenStream);
  }
}

function addTrackOnce(pc, track, stream) {
  const alreadyAdded = pc.getSenders().some((sender) => sender.track === track);
  if (!alreadyAdded) {
    pc.addTrack(track, stream);
  }
}

async function handleSignal(payload) {
  if (payload.to !== app.clientId || payload.roomId !== app.currentVoiceId) {
    return;
  }

  const peer = await ensurePeer(payload.from);
  if (!peer) {
    return;
  }

  const { pc } = peer;

  try {
    if (payload.description) {
      const description = payload.description;
      const offerCollision =
        description.type === "offer" &&
        (peer.makingOffer || pc.signalingState !== "stable");

      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) {
        return;
      }

      await pc.setRemoteDescription(description);
      if (description.type === "offer") {
        await pc.setLocalDescription();
        await sendSignal(payload.from, { description: pc.localDescription });
      }
    } else if (payload.candidate) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch (error) {
        if (!peer.ignoreOffer) {
          throw error;
        }
      }
    }
  } catch (error) {
    console.warn("signal handling failed", error);
  }
}

function sendSignal(to, data) {
  return postJson("/api/signal", {
    from: app.clientId,
    to,
    roomId: app.currentVoiceId,
    ...data
  });
}

function attachRemoteTrack(peerId, track, streams = []) {
  const media = app.remoteMedia.get(peerId) || {};
  const stream = streams[0] || new MediaStream([track]);
  if (track.kind === "audio") {
    media.audioStream = stream;
  }
  if (track.kind === "video") {
    media.videoStreams = media.videoStreams || new Map();
    media.videoStreams.set(track.id, stream);
    track.addEventListener("ended", () => {
      const current = app.remoteMedia.get(peerId);
      if (current?.videoStreams) {
        current.videoStreams.delete(track.id);
      }
      renderVoiceStage();
    });
  }
  app.remoteMedia.set(peerId, media);
  renderVoiceStage();
}

function render() {
  renderChannels();
  renderProfile();
  renderChatHeader();
  renderMessages();
  renderVoiceControls();
  renderVoiceStage();
  renderMembers();
  renderChatTab();
  renderDeviceControls();
  renderCallIndicators();
}

function renderChannels() {
  const server = getCurrentServer();
  dom.channelList.replaceChildren();
  if (!server) {
    return;
  }

  dom.workspaceName.textContent = server.name;

  for (const section of server.sections) {
    const wrapper = document.createElement("section");
    wrapper.className = "channel-section";

    const title = document.createElement("h2");
    title.className = "section-title";
    title.textContent = section.name;
    wrapper.append(title);

    for (const channel of section.channels) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "channel-button";
      if (section.type === "text" && channel.id === app.currentChannelId) {
        button.classList.add("is-active");
      }
      if (section.type === "voice" && channel.id === app.currentVoiceId) {
        button.classList.add("is-joined");
      }

      const symbol = document.createElement("span");
      symbol.className = "channel-symbol";
      symbol.textContent = section.type === "text" ? "#" : ">";
      button.append(symbol);

      const name = document.createElement("span");
      name.className = "channel-name";
      name.textContent = channel.name;
      button.append(name);

      const count = document.createElement("span");
      count.className = "peer-count";
      count.textContent =
        section.type === "voice" ? String((app.voiceRooms[channel.id] || []).length) : "";
      button.append(count);

      button.addEventListener("click", () => {
        if (section.type === "text") {
          selectTextChannel(channel.id);
          setChatOpen(true);
        } else {
          joinVoice(channel.id);
        }
      });

      wrapper.append(button);
    }

    dom.channelList.append(wrapper);
  }
}

async function selectTextChannel(channelId) {
  app.currentChannelId = channelId;
  renderChatHeader();
  await loadMessages(channelId);
  renderChannels();
}

function renderProfile() {
  dom.profileName.textContent = app.name || "guest";
  dom.profileAvatar.textContent = getInitials(app.name || "guest");
  dom.profileStatus.textContent = app.cameraStream
    ? "camera on"
    : app.currentVoiceId
      ? "in voice"
      : "ready";
}

function renderChatHeader() {
  const channel = getChannel(app.currentChannelId, "text");
  dom.chatTitle.textContent = channel ? `# ${channel.name}` : "# channel";
  dom.chatTopic.textContent = channel?.topic || "";
  dom.messageInput.placeholder = channel ? `message #${channel.name}` : "message";
}

function renderMessages() {
  const messages = app.messages.get(app.currentChannelId) || [];
  dom.messageList.replaceChildren();

  for (const message of messages) {
    const row = document.createElement("article");
    row.className = "message-row";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = getInitials(message.authorName);
    row.append(avatar);

    const body = document.createElement("div");

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const name = document.createElement("strong");
    name.textContent = message.authorName;
    meta.append(name);

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(message.createdAt);
    meta.append(time);

    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text;

    body.append(meta, text);
    row.append(body);
    dom.messageList.append(row);
  }

  dom.messageList.scrollTop = dom.messageList.scrollHeight;
}

function renderVoiceControls() {
  const inVoice = Boolean(app.currentVoiceId);
  const room = getChannel(app.currentVoiceId, "voice");
  const muteLabel = dom.muteButton.querySelector(".button-label");
  const muteHelper = dom.muteButton.querySelector(".button-helper");
  dom.voiceTitle.textContent = room ? room.name : "no room joined";
  dom.muteButton.disabled = !inVoice;
  dom.muteButton.classList.toggle("is-muted", app.muted);
  dom.muteButton.setAttribute("aria-pressed", String(app.muted));
  dom.muteButton.title = app.muted
    ? "microphone muted. click to unmute."
    : "microphone on. click to mute.";
  dom.cameraButton.disabled = !inVoice;
  dom.shareButton.disabled = !inVoice;
  dom.leaveVoiceButton.disabled = !inVoice;
  dom.cameraButton.classList.toggle("is-active", Boolean(app.cameraStream));
  dom.shareButton.classList.toggle("is-active", Boolean(app.screenStream));
  muteLabel.textContent = app.muted ? "unmute mic" : "mute mic";
  muteHelper.textContent = app.muted ? "mic is off" : "mic is on";
  dom.cameraButton.querySelector("span:last-child").textContent = app.cameraStream
    ? "stop camera"
    : "camera";
  dom.shareButton.querySelector("span:last-child").textContent = app.screenStream
    ? "stop sharing"
    : "share screen";
  renderCallIndicators();
}

function renderCallIndicators() {
  renderMicStatus();
  renderScreenStatus();
  renderQualityStatus();
  renderNetworkStatus();
}

function renderMicStatus() {
  if (!app.currentVoiceId || !app.micStream) {
    setPill(dom.micStatus, "mic idle", "idle");
    return;
  }
  if (app.muted) {
    setPill(dom.micStatus, "mic muted", "poor");
    return;
  }
  const isActive = app.micLevel > 0.035;
  setPill(dom.micStatus, isActive ? "mic active" : "mic quiet", isActive ? "good" : "idle");
}

function renderScreenStatus() {
  if (!app.screenStream) {
    setPill(dom.screenStatus, "screen idle", "idle");
    return;
  }

  const [track] = app.screenStream.getVideoTracks();
  const settings = track?.getSettings?.() || {};
  const size = settings.width && settings.height ? `${settings.width}x${settings.height}` : "screen";
  const frameRate = settings.frameRate ? ` · ${Math.round(settings.frameRate)} fps` : "";
  setPill(dom.screenStatus, `sharing ${size}${frameRate}`, "good");
}

function renderQualityStatus() {
  setPill(dom.qualityStatus, app.qualitySnapshot.qualityText, app.qualitySnapshot.qualityTone);
}

function renderNetworkStatus() {
  setPill(dom.networkStatus, app.qualitySnapshot.networkText, app.qualitySnapshot.networkTone);
}

function setPill(element, text, tone) {
  if (!element) {
    return;
  }
  element.textContent = text;
  element.classList.remove("is-good", "is-fair", "is-poor", "is-idle");
  element.classList.add(`is-${tone || "idle"}`);
}

function setChatOpen(isOpen) {
  app.chatOpen = isOpen;
  renderChatTab();
}

function renderChatTab() {
  dom.mainPane.classList.toggle("is-chat-open", app.chatOpen);
  dom.chatTabButton.classList.toggle("is-active", app.chatOpen);
  dom.chatTabButton.setAttribute("aria-expanded", String(app.chatOpen));
  dom.chatPanel.setAttribute("aria-hidden", String(!app.chatOpen));
}

function renderVoiceStage() {
  dom.stageGrid.replaceChildren();
  const peers = getCurrentVoicePeers();

  if (!app.currentVoiceId) {
    const empty = document.createElement("div");
    empty.className = "stage-empty";
    empty.textContent = "join a voice room";
    dom.stageGrid.append(empty);
    return;
  }

  const localPeer = {
    clientId: app.clientId,
    name: `${app.name || "you"} (you)`
  };

  if (app.screenStream || app.cameraStream) {
    if (app.screenStream) {
      dom.stageGrid.append(createParticipantTile(localPeer, {
        stream: app.screenStream,
        mode: "screen"
      }));
    }
    if (app.cameraStream) {
      dom.stageGrid.append(createParticipantTile(localPeer, {
        stream: app.cameraStream,
        mode: "camera"
      }));
    }
  } else {
    dom.stageGrid.append(createParticipantTile(localPeer));
  }

  for (const peer of peers.filter((item) => item.clientId !== app.clientId)) {
    const media = app.remoteMedia.get(peer.clientId);
    const videoStreams = [...(media?.videoStreams?.values() || [])];

    if (videoStreams.length === 0) {
      dom.stageGrid.append(createParticipantTile(peer, { includeAudio: true }));
      continue;
    }

    videoStreams.forEach((stream, index) => {
      dom.stageGrid.append(createParticipantTile(peer, {
        stream,
        mode: getRemoteVideoMode(peer.clientId, index, videoStreams.length),
        includeAudio: index === 0
      }));
    });
  }
}

function createParticipantTile(peer, options = {}) {
  const tile = document.createElement("div");
  tile.className = "participant-tile";
  if (options.mode) {
    tile.classList.add(`is-${options.mode}`);
  }
  const isLocal = peer.clientId === app.clientId;
  const media = app.remoteMedia.get(peer.clientId);
  const videoStream = options.stream || null;

  if (videoStream) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    video.srcObject = videoStream;
    tile.append(video);
  } else {
    const initial = document.createElement("div");
    initial.className = "participant-initial";
    initial.textContent = getInitials(peer.name);
    tile.append(initial);
  }

  if (!isLocal && options.includeAudio !== false && media?.audioStream) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = media.audioStream;
    applyAudioOutput(audio);
    tile.append(audio);
  }

  const label = document.createElement("div");
  label.className = "tile-label";
  const labelText = document.createElement("span");
  labelText.textContent = getTileLabel(peer, options.mode);
  label.append(labelText);
  tile.append(label);

  return tile;
}

function getTileLabel(peer, mode) {
  if (mode === "screen") {
    return `${peer.name} sharing`;
  }
  if (mode === "camera") {
    return `${peer.name} camera`;
  }
  return peer.name;
}

function getRemoteVideoMode(clientId, index, totalVideoStreams) {
  if (app.screenShares[clientId]) {
    return index === 0 || totalVideoStreams === 1 ? "screen" : "camera";
  }
  return "camera";
}

function renderMembers() {
  dom.memberList.replaceChildren();
  const users = app.onlineUsers.filter((user) => user.roomId === app.currentRoomId);
  dom.memberCount.textContent = `${users.length} member${users.length === 1 ? "" : "s"}`;

  for (const user of users) {
    const row = document.createElement("div");
    row.className = "member-row";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = getInitials(user.name);
    row.append(avatar);

    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = user.clientId === app.clientId ? `${user.name} (you)` : user.name;
    const status = document.createElement("span");
    status.textContent = getUserVoiceRoomName(user.clientId) || "online";
    copy.append(name, status);
    row.append(copy);
    dom.memberList.append(row);
  }
}

function setConnectionStatus(text, isLive) {
  dom.connectionStatus.textContent = text;
  dom.connectionStatus.classList.toggle("is-live", isLive);
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    renderDeviceControls();
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    app.devices = {
      microphones: devices.filter((device) => device.kind === "audioinput"),
      speakers: devices.filter((device) => device.kind === "audiooutput"),
      cameras: devices.filter((device) => device.kind === "videoinput")
    };
  } catch (error) {
    console.warn("could not read media devices", error);
  }

  renderDeviceControls();
}

function renderDeviceControls() {
  const hasMediaDevices = Boolean(navigator.mediaDevices?.getUserMedia);
  const canSelectSpeaker = Boolean(HTMLMediaElement.prototype.setSinkId);

  app.selectedMicrophoneId = populateDeviceSelect(
    dom.microphoneSelect,
    app.devices.microphones,
    app.selectedMicrophoneId,
    "default microphone",
    "microphone"
  );
  app.selectedSpeakerId = populateDeviceSelect(
    dom.speakerSelect,
    app.devices.speakers,
    app.selectedSpeakerId,
    canSelectSpeaker ? "default speaker" : "browser default speaker",
    "speaker"
  );
  app.selectedCameraId = populateDeviceSelect(
    dom.cameraSelect,
    app.devices.cameras,
    app.selectedCameraId,
    "default camera",
    "camera"
  );

  dom.microphoneSelect.disabled = !hasMediaDevices || app.devices.microphones.length === 0;
  dom.speakerSelect.disabled = !canSelectSpeaker || app.devices.speakers.length === 0;
  dom.cameraSelect.disabled = !hasMediaDevices || app.devices.cameras.length === 0;
}

function populateDeviceSelect(select, devices, selectedId, defaultLabel, fallbackLabel) {
  if (!select) {
    return "";
  }

  select.replaceChildren(createOption("", defaultLabel));
  devices.forEach((device, index) => {
    if (!device.deviceId) {
      return;
    }
    const label = (device.label || `${fallbackLabel} ${index + 1}`).toLowerCase();
    select.append(createOption(device.deviceId, label));
  });

  const hasSelectedDevice = selectedId && devices.some((device) => device.deviceId === selectedId);
  const nextValue = hasSelectedDevice ? selectedId : "";
  select.value = nextValue;
  return nextValue;
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

async function selectMicrophone(deviceId) {
  app.selectedMicrophoneId = deviceId;
  renderDeviceControls();
  if (!app.currentVoiceId || !app.micStream) {
    return;
  }

  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraints(),
      video: false
    });
    const [nextTrack] = nextStream.getAudioTracks();
    if (!nextTrack) {
      stopStream(nextStream);
      showToast("microphone was not available.");
      return;
    }

    nextTrack.enabled = !app.muted;
    for (const peer of app.peers.values()) {
      let replaced = false;
      for (const sender of peer.pc.getSenders()) {
        if (sender.track?.kind === "audio") {
          await sender.replaceTrack(nextTrack);
          replaced = true;
        }
      }
      if (!replaced) {
        addTrackOnce(peer.pc, nextTrack, nextStream);
      }
    }

    stopMicMonitor();
    stopStream(app.micStream);
    app.micStream = nextStream;
    startMicMonitor();
    await refreshDevices();
    renderVoiceControls();
  } catch (error) {
    showToast("could not switch microphone.");
  }
}

async function selectSpeaker(deviceId) {
  app.selectedSpeakerId = deviceId;
  renderDeviceControls();
  await applyAudioOutputToAll();
}

async function selectCamera(deviceId) {
  app.selectedCameraId = deviceId;
  renderDeviceControls();
  if (!app.cameraStream) {
    return;
  }

  stopCamera();
  await startCamera();
}

function getAudioConstraints() {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(app.selectedMicrophoneId ? { deviceId: { exact: app.selectedMicrophoneId } } : {})
  };
}

function getCameraConstraints() {
  return {
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 60 },
    ...(app.selectedCameraId ? { deviceId: { exact: app.selectedCameraId } } : { facingMode: "user" })
  };
}

async function applyAudioOutputToAll() {
  await Promise.all([...document.querySelectorAll("audio")].map((audio) => applyAudioOutput(audio)));
}

async function applyAudioOutput(element) {
  if (!element || typeof element.setSinkId !== "function") {
    return;
  }

  try {
    await element.setSinkId(app.selectedSpeakerId || "");
  } catch (error) {
    console.warn("speaker selection failed", error);
  }
}

function setMicEnabled(isEnabled) {
  if (!app.micStream) {
    return;
  }
  for (const track of app.micStream.getAudioTracks()) {
    track.enabled = isEnabled;
  }
}

function startMicMonitor() {
  stopMicMonitor();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !app.micStream) {
    renderMicStatus();
    return;
  }

  try {
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(app.micStream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const data = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    const readLevel = () => {
      analyser.getByteTimeDomainData(data);
      let total = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        total += normalized * normalized;
      }
      app.micLevel = Math.sqrt(total / data.length);
      renderMicStatus();
      app.micMonitor.frame = requestAnimationFrame(readLevel);
    };

    app.micMonitor = { context, source, analyser, frame: 0 };
    readLevel();
  } catch (error) {
    app.micLevel = 0;
    renderMicStatus();
  }
}

function stopMicMonitor() {
  if (!app.micMonitor) {
    app.micLevel = 0;
    return;
  }

  cancelAnimationFrame(app.micMonitor.frame);
  app.micMonitor.source?.disconnect();
  app.micMonitor.context?.close?.();
  app.micMonitor = null;
  app.micLevel = 0;
}

function startQualityMonitoring() {
  stopQualityMonitoring();
  app.qualityTimer = setInterval(sampleConnectionQuality, 2500);
  sampleConnectionQuality();
}

function stopQualityMonitoring() {
  if (app.qualityTimer) {
    clearInterval(app.qualityTimer);
    app.qualityTimer = null;
  }
  app.lastStats.clear();
  app.qualitySnapshot = {
    qualityText: "quality idle",
    qualityTone: "idle",
    networkText: "network idle",
    networkTone: "idle"
  };
  renderQualityStatus();
  renderNetworkStatus();
}

async function sampleConnectionQuality() {
  if (!app.currentVoiceId) {
    return;
  }

  const peers = [...app.peers.values()];
  if (peers.length === 0) {
    app.qualitySnapshot = {
      qualityText: "quality local",
      qualityTone: "idle",
      networkText: "waiting for peers",
      networkTone: "idle"
    };
    renderQualityStatus();
    renderNetworkStatus();
    return;
  }

  let connected = 0;
  let checking = 0;
  let failed = 0;
  let maxRtt = 0;
  let lostPackets = 0;
  let totalPackets = 0;

  for (const peer of peers) {
    const state = peer.pc.connectionState || peer.pc.iceConnectionState;
    if (state === "connected" || state === "completed") {
      connected += 1;
    } else if (state === "failed" || state === "disconnected" || state === "closed") {
      failed += 1;
    } else {
      checking += 1;
    }

    try {
      const reports = await peer.pc.getStats();
      for (const report of reports.values()) {
        if (report.type === "candidate-pair" && report.state === "succeeded" && typeof report.currentRoundTripTime === "number") {
          maxRtt = Math.max(maxRtt, report.currentRoundTripTime);
        }
        if (report.type === "inbound-rtp" && typeof report.packetsReceived === "number") {
          const key = `${peer.peerId}:${report.id}`;
          const previous = app.lastStats.get(key);
          const currentLost = Math.max(0, report.packetsLost || 0);
          const currentReceived = Math.max(0, report.packetsReceived || 0);
          if (previous) {
            const lostDelta = Math.max(0, currentLost - previous.lost);
            const receivedDelta = Math.max(0, currentReceived - previous.received);
            lostPackets += lostDelta;
            totalPackets += lostDelta + receivedDelta;
          }
          app.lastStats.set(key, { lost: currentLost, received: currentReceived });
        }
      }
    } catch (error) {
      failed += 1;
    }
  }

  const packetLoss = totalPackets > 0 ? lostPackets / totalPackets : 0;
  const packetLossText = `packet loss ${Math.round(packetLoss * 100)}%`;
  let qualityTone = "good";
  if (failed > 0 || packetLoss > 0.08 || maxRtt > 0.4) {
    qualityTone = "poor";
  } else if (checking > 0 || packetLoss > 0.03 || maxRtt > 0.2) {
    qualityTone = "fair";
  }

  app.qualitySnapshot = {
    qualityText: `quality ${qualityTone} · ${packetLossText}`,
    qualityTone,
    networkText: getNetworkQualityText({ connected, checking, failed, total: peers.length }),
    networkTone: failed > 0 ? "poor" : checking > 0 ? "fair" : "good"
  };
  renderQualityStatus();
  renderNetworkStatus();
}

function getNetworkQualityText({ connected, checking, failed, total }) {
  if (failed > 0) {
    return `network poor · ${failed} failed`;
  }
  if (checking > 0) {
    return `network checking · ${connected}/${total} live`;
  }
  return `network live · ${connected} peer${connected === 1 ? "" : "s"}`;
}

function getScreenShareErrorMessage(error) {
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return "screen sharing needs https or localhost.";
  }
  if (error?.name === "NotAllowedError") {
    return "screen sharing permission was not granted.";
  }
  if (error?.name === "NotFoundError") {
    return "no screen source was available.";
  }
  return "screen share was cancelled.";
}

function getCurrentServer() {
  return app.servers.find((server) => server.id === app.currentServerId) || app.servers[0];
}

function getChannel(channelId, type) {
  for (const server of app.servers) {
    for (const section of server.sections) {
      if (section.type !== type) {
        continue;
      }
      const channel = section.channels.find((item) => item.id === channelId);
      if (channel) {
        return channel;
      }
    }
  }
  return null;
}

function getCurrentVoicePeers() {
  return app.currentVoiceId ? app.voiceRooms[app.currentVoiceId] || [] : [];
}

function getUserVoiceRoomName(clientId) {
  for (const [roomId, peers] of Object.entries(app.voiceRooms)) {
    if (peers.some((peer) => peer.clientId === clientId)) {
      return getChannel(roomId, "voice")?.name || "in voice";
    }
  }
  return "";
}

function getInitials(name) {
  const parts = String(name || "guest")
    .replace(/\(you\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return (parts.map((part) => part[0]).join("") || "g").toLowerCase();
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function parseEvent(event) {
  try {
    return JSON.parse(event.data);
  } catch (error) {
    return {};
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`);
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`);
  }
  return response.json();
}

function stopStream(stream) {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 3200);
}

function getClientId() {
  return `client-${crypto.randomUUID()}`;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
}
