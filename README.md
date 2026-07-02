# schibb's mic

schibb's mic is an app scaffold that runs in the browser and can be wrapped as a windows desktop app with electron. it starts with a room lobby that asks for a username and room name every visit, lists active rooms, and then opens text chat, voice, camera video, and screen sharing requested at a maximum of 1920x1080 and 60fps.

## run in a browser

the browser server uses only built-in node.js modules.

```bash
node server.js
```

then open:

```text
http://127.0.0.1:3000
```

for microphone and screen sharing, use `localhost`, `127.0.0.1`, or https. browsers block media capture on ordinary insecure origins.

## windows desktop

the desktop app uses the same browser app inside electron. without a hosted url, it starts a private local server for development.

```bash
npm install
npm run desktop:dev
```

after hosting the app online, paste the hosted url into `electron/app-config.cjs`:

```js
module.exports = {
  hostedAppUrl: "https://schibbs-mic.onrender.com"
};
```

then build a windows installer:

```bash
npm run desktop:build:win
```

the generated installer is produced by `electron-builder`. build it on windows or a windows ci runner for the smoothest installer output. when `hostedAppUrl` is set before the build, browser users and windows app users connect to the same hosted rooms, chat, voice state, and webrtc signaling server.

you can also test a hosted url without editing the config. this is for development only; set `hostedAppUrl` before building an installer for other users.

```bash
SCHIBBS_MIC_URL=https://schibbs-mic.onrender.com npm run desktop:dev
```

on windows powershell:

```powershell
$env:SCHIBBS_MIC_URL="https://schibbs-mic.onrender.com"; npm run desktop:dev
```

## host online with render

the simplest hosting path for the current app is a render web service.

1. push this folder to a github repository.
2. in render, create a new web service from that repo.
3. use these settings:

```text
runtime: node
build command: npm install --omit=dev
start command: npm start
```

4. deploy and copy the https url render gives you.
5. put that url in `electron/app-config.cjs`.
6. build the windows installer with `npm run desktop:build:win`.

## current architecture

- `server.js` serves the app, stores in-memory rooms, messages, and room state, and provides server-sent events for realtime room lists, chat, presence, voice membership, and webrtc signaling.
- `public/app.js` is the browser client. it handles the lobby, room creation/joining, channel navigation, chat, voice-room joining, peer connections, microphone tracks, camera tracks, and screen-share tracks.
- `public/manifest.webmanifest` and `public/service-worker.js` make the browser version installable as a pwa.
- `electron/main.cjs` loads the hosted app when `hostedAppUrl` or `SCHIBBS_MIC_URL` is set. otherwise, it starts the local server on a private port and loads it in a desktop window.

## production notes

this version uses peer-to-peer webrtc mesh rooms, which is appropriate for small rooms and local testing. to support larger rooms, add:

- an sfu media server such as livekit, mediasoup, or janus for large voice/video rooms.
- turn servers for users behind restrictive nats and corporate networks.
- persistent auth, users, servers, channels, and message storage.
- https and secure deployment for browser media permissions.

the client requests screen capture with `width <= 1920`, `height <= 1080`, and `frameRate <= 60`. the actual delivered quality still depends on the browser, operating system, capture source, cpu, and network conditions.
