// ============================================================
// Relay Server for Jackbox-style game

// All game logic stays in Unity. This server just:
//   1. Lets a host create a room (returns a 4-letter code)
//   2. Lets players join by code
//   3. Forwards messages between host <-> players
// ============================================================

const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 8080;

// --- Room Management ---

const rooms = new Map(); // code -> { host: ws, players: Map<id, ws>, createdAt }

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O (avoid confusion with 1/0)
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// Clean up stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // remove rooms older than 4 hours or with no host
    if (now - room.createdAt > 4 * 60 * 60 * 1000 || !room.host) {
      console.log(`[cleanup] Removing stale room ${code}`);
      // close all player connections
      for (const [, ws] of room.players) {
        ws.close(1000, "Room expired");
      }
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

// --- HTTP Server (health check + simple landing) ---

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Game relay server is running.");
});

// --- WebSocket Server ---

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws) => {
  let role = null;     // "host" or "player"
  let roomCode = null;
  let playerId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
      return;
    }

    // --- HOST: Create a room ---
    if (msg.type === "create_room") {
      const code = generateRoomCode();
      rooms.set(code, {
        host: ws,
        players: new Map(),
        createdAt: Date.now(),
      });
      role = "host";
      roomCode = code;
      console.log(`[room] Host created room ${code}`);
      ws.send(JSON.stringify({ type: "room_created", roomCode: code }));
      return;
    }

    // --- PLAYER: Join a room ---
    if (msg.type === "join_room") {
      const code = (msg.roomCode || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: "error", text: "Room not found" }));
        return;
      }
      if (!room.host) {
        ws.send(JSON.stringify({ type: "error", text: "Host has disconnected" }));
        return;
      }

      // generate a unique player ID for this connection
      playerId = "p_" + Math.random().toString(36).substring(2, 10);
      role = "player";
      roomCode = code;
      room.players.set(playerId, ws);

      console.log(`[room] Player ${playerId} joined room ${code} (${room.players.size} players)`);
      ws.send(JSON.stringify({ type: "room_joined", roomCode: code, playerId }));

      // notify host that a new socket connected (host will get the
      // actual "join" game message when the player sends their name)
      return;
    }

    // --- HOST -> PLAYER(S): forward a message ---
    if (role === "host" && roomCode) {
      const room = rooms.get(roomCode);
      if (!room) return;

      if (msg.target === "all") {
        // broadcast to all players
        for (const [, playerWs] of room.players) {
          if (playerWs.readyState === WebSocket.OPEN) {
            playerWs.send(JSON.stringify(msg.payload));
          }
        }
      } else if (msg.target) {
        // send to specific player
        const playerWs = room.players.get(msg.target);
        if (playerWs && playerWs.readyState === WebSocket.OPEN) {
          playerWs.send(JSON.stringify(msg.payload));
        }
      }
      return;
    }

    // --- PLAYER -> HOST: forward a message ---
    if (role === "player" && roomCode) {
      const room = rooms.get(roomCode);
      if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) return;

      // wrap with sender ID so host knows who sent it
      room.host.send(JSON.stringify({
        type: "player_message",
        playerId,
        payload: msg,
      }));
      return;
    }

    // if we get here, connection hasn't identified itself yet
    ws.send(JSON.stringify({ type: "error", text: "Send create_room or join_room first" }));
  });

  ws.on("close", () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (role === "host") {
      console.log(`[room] Host disconnected from room ${roomCode}`);
      // notify all players
      for (const [, playerWs] of room.players) {
        if (playerWs.readyState === WebSocket.OPEN) {
          playerWs.send(JSON.stringify({ type: "host_disconnected" }));
        }
      }
      room.host = null;
      // don't delete room immediately — host might reconnect
      // cleanup timer will handle it
    } else if (role === "player") {
      console.log(`[room] Player ${playerId} disconnected from room ${roomCode}`);
      room.players.delete(playerId);
      // notify host
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
          type: "player_disconnected",
          playerId,
        }));
      }
    }
  });

  ws.on("error", (err) => {
    console.error("[ws error]", err.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
