# schibb's mic

schibb's mic is a Discord-style app scaffold that runs in the browser and can be wrapped as a Windows desktop app with Electron. It starts with a room lobby that asks for a username and room name every visit, lists active rooms, and then opens text chat, voice, camera video, and screen sharing requested at a maximum of 1920x1080 and 60fps.

## Run In A Browser

The browser server uses only built-in Node.js modules.

```bash
node server.js
```

Then open:

```text
http://127.0.0.1:3000
```

For microphone and screen sharing, use `localhost`, `127.0.0.1`, or HTTPS. Browsers block media capture on ordinary insecure origins.

## Windows Desktop

The desktop app uses the same browser app inside Electron. Without a hosted URL, it starts a private local server for development.

```bash
npm install
npm run desktop:dev
```

After hosting the app online, paste the hosted URL into `electron/app-config.cjs`:

```js
module.exports = {
  hostedAppUrl: "https://your-schibbs-mic.onrender.com"
};
```

Then build a Windows installer:

```bash
npm run desktop:build:win
```

The generated installer is produced by `electron-builder`. Build it on Windows or a Windows CI runner for the smoothest installer output. When `hostedAppUrl` is set before the build, browser users and Windows app users connect to the same hosted rooms, chat, voice state, and WebRTC signaling server.

You can also test a hosted URL without editing the config. This is for development only; set `hostedAppUrl` before building an installer for other users.

```bash
SCHIBBS_MIC_URL=https://your-schibbs-mic.onrender.com npm run desktop:dev
```

On Windows PowerShell:

```powershell
$env:SCHIBBS_MIC_URL="https://your-schibbs-mic.onrender.com"; npm run desktop:dev
```

## Host Online With Render

The simplest hosting path for the current app is a Render Web Service.

1. Push this folder to a GitHub repository.
2. In Render, create a new Web Service from that repo.
3. Use these settings:

```text
Runtime: Node
Build command: npm install --omit=dev
Start command: npm start
```

4. Deploy and copy the HTTPS URL Render gives you.
5. Put that URL in `electron/app-config.cjs`.
6. Build the Windows installer with `npm run desktop:build:win`.

## Current Architecture

- `server.js` serves the app, stores in-memory rooms, messages, and room state, and provides Server-Sent Events for realtime room lists, chat, presence, voice membership, and WebRTC signaling.
- `public/app.js` is the browser client. It handles the lobby, room creation/joining, channel navigation, chat, voice-room joining, peer connections, microphone tracks, camera tracks, and screen-share tracks.
- `public/manifest.webmanifest` and `public/service-worker.js` make the browser version installable as a PWA.
- `electron/main.cjs` loads the hosted app when `hostedAppUrl` or `SCHIBBS_MIC_URL` is set. Otherwise, it starts the local server on a private port and loads it in a desktop window.

## Production Notes

This version uses peer-to-peer WebRTC mesh rooms, which is appropriate for small rooms and local testing. To match Discord-style scale, add:

- An SFU media server such as LiveKit, mediasoup, or Janus for large voice/video rooms.
- TURN servers for users behind restrictive NATs and corporate networks.
- Persistent auth, users, servers, channels, and message storage.
- HTTPS and secure deployment for browser media permissions.

The client requests screen capture with `width <= 1920`, `height <= 1080`, and `frameRate <= 60`. The actual delivered quality still depends on the browser, operating system, capture source, CPU, and network conditions.
