#!/usr/bin/env node
/*
 * ===========================================================================
 *  Robotic Horror Tunnel - remote access relay
 *  ---------------------------------------------------------------------------
 *  The boards of the tunnel connect OUT to this small server, therefore no
 *  port forwarding, no VPN, no modem/hotspot change and no smartphone app is
 *  needed (specification section 8.5).
 *
 *  Browser  --https-->  relay  <--wss (outbound)-- ESP32 board
 *
 *  Usage:
 *      npm install
 *      node relay.js                    (listens on port 8080)
 *      PORT=3000 BOARD_TOKEN=secret node relay.js
 *      PUBLIC_URL=https://my-relay.example.com node relay.js
 *
 *  Endpoints:
 *      GET  /            landing page (lists the rooms that are on-line)
 *      GET  /app/?room=X the dashboard of room X (all REST calls are proxied)
 *      POST /app/api/... the same REST surface, proxied to the board
 *      WS   /ws?room=X   live telemetry socket for the dashboard
 *      WS   /board?room=X&token=Y   the ESP32 boards connect here
 *      GET  /health      {"ok":true,...}
 *
 *  Author: Ali Tehrani - 09303702721
 * ===========================================================================
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const BOARD_TOKEN = process.env.BOARD_TOKEN || '';   // optional shared secret
const IDLE_ROOM_MS = 10 * 60 * 1000;                 // forget idle rooms
const REQUEST_TIMEOUT_MS = 25000;
const CHUNK = 3500;

/** rooms: code -> {board, viewers:Set, pending:Map, seq, lastSeen} */
const rooms = new Map();

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { code, board: null, viewers: new Set(), pending: new Map(), seq: 1, lastSeen: Date.now() };
    rooms.set(code, r);
    console.log('[room] created', code);
  }
  r.lastSeen = Date.now();
  return r;
}

function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function dashboardUrl(req, code) {
  return `${publicBase(req)}/app/?room=${encodeURIComponent(code)}`;
}

/* --------------------------------------------------------------------------
 * HTTP
 * ------------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/health') {
    return json(res, 200, {
      ok: true,
      rooms: [...rooms.keys()],
      boards: [...rooms.values()].filter(r => r.board && r.board.readyState === 1).length,
      uptime: Math.round(process.uptime())
    });
  }

  if (path === '/' || path === '/index.html') {
    return landing(req, res);
  }

  if (path === '/app' || path.startsWith('/app/')) {
    // TWO address forms are accepted, because both are natural to type:
    //     /app/?room=eng01        (query form)
    //     /app/eng01              (short form - what the operator usually types)
    // The short form used to answer "room parameter is missing", which is
    // exactly the error that was reported from the field.
    let code = url.searchParams.get('room') || '';
    let rest = path.replace(/^\/app/, '');
    const segs = rest.split('/').filter(Boolean);
    if (segs.length && segs[0] !== 'api' && segs[0] !== 'ws' && segs[0] !== 'health') {
      if (!code) code = decodeURIComponent(segs[0]);
      if (segs[0] === code || decodeURIComponent(segs[0]) === code) {
        rest = rest.substring(rest.indexOf(segs[0]) + segs[0].length);
      }
    }
    if (!code) {
      return json(res, 400, {
        ok: false,
        error: 'room parameter is missing',
        hint: 'Use /app/YOUR_ROOM or /app/?room=YOUR_ROOM - for example /app/eng01'
      });
    }
    let target = rest === '' ? '/' : rest;
    if (!target.startsWith('/')) target = '/' + target;
    target += url.search || '';          // keep ?t=... and everything else
    const body = await readBody(req);
    return proxyToBoard(req, res, code, target, body);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found. Use /app/YOUR_ROOM (for example /app/eng01) or /app/?room=YOUR_ROOM');
});

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function landing(req, res) {
  const rows = [...rooms.values()].map(r => {
    const online = r.board && r.board.readyState === 1;
    return `<tr><td>${r.code}</td>
      <td>${online ? '<b style="color:#39d353">on-line</b>' : '<span style="color:#f85149">off-line</span>'}</td>
      <td>${r.viewers.size}</td>
      <td>${online ? `<a href="/app/?room=${encodeURIComponent(r.code)}">open dashboard</a>` : '-'}</td>
      <td class="u">${dashboardUrl(req, r.code)}</td></tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Robotic Horror Tunnel - relay</title>
<style>body{background:#0d1117;color:#e6edf3;font:14px system-ui,Arial;padding:24px;max-width:900px;margin:auto}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #2b3542;padding:6px;text-align:left}
.u{font-family:monospace;font-size:12px;color:#93a1b1}code{background:#161b22;padding:2px 5px;border-radius:4px}</style>
</head><body>
<h1>Robotic Horror Tunnel - remote relay</h1>
<p>This relay gives your boards a public address without port forwarding, VPN or router changes.</p>
<ol>
<li>On every board open <b>Connection</b>, enable remote access and fill in this host, port ${PORT} and a room code.</li>
<li>Open the dashboard of a room with <code>/app/ROOM</code> or <code>/app/?room=ROOM</code>.</li>
<li>Both forms work; the room code is the only secret, so keep it long.</li>
<li>The room code is the only secret - use a long random value.</li>
</ol>
<h2>Rooms currently known</h2>
<table><tr><th>Room</th><th>Board</th><th>Viewers</th><th>Link</th><th>Full address</th></tr>
${rows || '<tr><td colspan="5">no board has connected yet</td></tr>'}</table>
<p class="u">Author: Ali Tehrani - 09303702721</p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/* --------------------------------------------------------------------------
 * HTTP -> board (request/response over the board websocket)
 * ------------------------------------------------------------------------ */
function proxyToBoard(req, res, code, target, body) {
  const r = getRoom(code);
  if (!r.board || r.board.readyState !== 1) {
    return json(res, 503, { ok: false, error: 'the board of this room is off-line' });
  }
  const id = r.seq++;
  const pending = { res, s: 200, c: 'application/json', body: '', parts: 0, got: 0 };
  r.pending.set(id, pending);

  const timer = setTimeout(() => {
    if (r.pending.delete(id)) {
      if (!res.headersSent) json(res, 504, { ok: false, error: 'the board did not answer in time' });
    }
  }, REQUEST_TIMEOUT_MS);

  const parts = Math.max(1, Math.ceil(body.length / CHUNK));
  for (let k = 0; k < parts; k++) {
    const msg = { t: 'req', id, m: req.method, p: target, parts };
    if (parts > 1) msg.part = k;
    msg.b = body.substr(k * CHUNK, CHUNK);
    r.board.send(JSON.stringify(msg));
  }
  pending.timer = timer;
}

function finishPending(r, id, status, ctype, body) {
  const p = r.pending.get(id);
  if (!p) return;
  r.pending.delete(id);
  clearTimeout(p.timer);
  if (!p.res.headersSent) {
    p.res.writeHead(status || 200, {
      'content-type': ctype || 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    p.res.end(body || '');
  }
}

/* --------------------------------------------------------------------------
 * WebSockets
 * ------------------------------------------------------------------------ */
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const code = url.searchParams.get('room') || '';
  const token = url.searchParams.get('token') || '';
  const isBoard = path !== '/ws';
  if (!code) { socket.destroy(); return; }
  if (isBoard && BOARD_TOKEN && token !== BOARD_TOKEN) {
    console.log('[auth] rejected board for room', code);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.isAlive = true;
    ws.roomCode = code;
    ws.isBoard = isBoard;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const r = getRoom(ws.roomCode);

  if (ws.isBoard) {
    if (r.board && r.board !== ws) { try { r.board.close(); } catch (e) {} }
    r.board = ws;
    console.log('[board] connected  room=' + r.code);
    broadcastToViewers(r, { t: 'board', ok: true, msg: 'board connected' });
    ws.on('close', () => {
      if (r.board === ws) r.board = null;
      console.log('[board] disconnected room=' + r.code);
      broadcastToViewers(r, { t: 'board', ok: false, msg: 'board disconnected' });
    });
  } else {
    r.viewers.add(ws);
    console.log('[view] connected   room=' + r.code + ' viewers=' + r.viewers.size);
    if (r.board && r.board.readyState === 1) r.board.send(JSON.stringify({ t: 'viewers', n: r.viewers.size }));
    ws.on('close', () => {
      r.viewers.delete(ws);
      if (r.board && r.board.readyState === 1) r.board.send(JSON.stringify({ t: 'viewers', n: r.viewers.size }));
    });
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    if (ws.isBoard) {
      if (msg.t === 'res') {
        if (msg.parts && msg.parts > 1) {
          const p = r.pending.get(msg.id);
          if (!p) return;
          if (msg.part === 0 || p.got === 0) { p.s = msg.s; p.c = msg.c; }
          p.body += msg.b || '';
          p.got++;
          if (p.got >= msg.parts) finishPending(r, msg.id, p.s, p.c, p.body);
        } else {
          finishPending(r, msg.id, msg.s, msg.c, msg.b);
        }
        return;
      }
      if (msg.t === 'hello') {
        ws.name = msg.n || '';
        return;
      }
      // anything else from the board is a push -> all viewers of the room
      broadcastToViewers(r, msg);
      return;
    }

    // viewer -> board
    if (r.board && r.board.readyState === 1) r.board.send(JSON.stringify(msg));
  });

  ws.on('pong', () => { ws.isAlive = true; });
});

function broadcastToViewers(r, msg) {
  const s = JSON.stringify(msg);
  for (const v of r.viewers) if (v.readyState === 1) { try { v.send(s); } catch (e) {} }
}

/* keep-alive + idle clean-up */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
    if (ws.readyState === 1 && !ws.isBoard) {
      try { ws.send(JSON.stringify({ t: 'ping' })); } catch (e) {}
    }
  });
  const now = Date.now();
  for (const [code, r] of rooms) {
    const idle = now - r.lastSeen > IDLE_ROOM_MS;
    const empty = (!r.board || r.board.readyState !== 1) && r.viewers.size === 0;
    if (idle && empty) { rooms.delete(code); console.log('[room] removed', code); }
  }
}, 25000);

server.listen(PORT, () => {
  console.log('===========================================================');
  console.log(' Robotic Horror Tunnel - relay listening on port ' + PORT);
  console.log(' Dashboard link:  http://localhost:' + PORT + '/app/?room=YOURROOM');
  console.log(' Board endpoint:  ws(s)://<this host>/board?room=YOURROOM&token=...');
  if (BOARD_TOKEN) console.log(' Board token is required (BOARD_TOKEN is set).');
  console.log('===========================================================');
});
