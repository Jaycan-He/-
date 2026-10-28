'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'public', 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Could not load game client.'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const wss = new WebSocket.Server({ server });
const rooms = new Map();
const SUITS = ['♠', '♥', '♣', '♦'];
const rankName = r => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] || String(r));
function deck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ s, r });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function evaluate(hand) {
  const rs = hand.map(c => c.r).sort((a, b) => b - a);
  const flush = hand.every(c => c.s === hand[0].s), counts = {};
  rs.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts).map(([r, n]) => ({ r: +r, n })).sort((a, b) => b.n - a.n || b.r - a.r);
  const is235 = rs.join(',') === '5,3,2';
  const unique = [...new Set(rs)];
  const straight = unique.length === 3 && (rs[0] - rs[2] === 2 || (rs[0] === 14 && rs[1] === 3 && rs[2] === 2));
  const seq = rs[0] === 14 && rs[1] === 3 && rs[2] === 2 ? [3, 2, 1] : rs;
  // Standard ranking: trips > straight flush > flush > straight > pair > high card.
  // Special 235 is evaluated separately in compareHands: it beats trips only.
  if (is235) return { cat: 7, vec: [5, 3, 2], label: '特殊牌 235' };
  if (groups[0].n === 3) return { cat: 8, vec: [groups[0].r], label: '豹子' };
  if (straight && flush) return { cat: 7, vec: seq, label: '顺金' };
  if (flush) return { cat: 5, vec: rs, label: '金花' };
  if (straight) return { cat: 4, vec: seq, label: '顺子' };
  if (groups[0].n === 2) return { cat: 3, vec: [groups[0].r, ...rs.filter(r => r !== groups[0].r)], label: '对子' };
  return { cat: 2, vec: rs, label: '单张' };
}
function compareHands(a, b) {
  const x = evaluate(a), y = evaluate(b);
  if (x.label === '特殊牌 235' && y.label === '特殊牌 235') return 0;
  if (x.label === '特殊牌 235') return y.label === '豹子' ? 1 : -1;
  if (y.label === '特殊牌 235') return x.label === '豹子' ? -1 : 1;
  if (x.cat !== y.cat) return x.cat - y.cat;
  for (let i = 0; i < Math.max(x.vec.length, y.vec.length); i++) if ((x.vec[i] || 0) !== (y.vec[i] || 0)) return (x.vec[i] || 0) - (y.vec[i] || 0);
  return 0;
}
function send(p, obj) { if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(obj)); }
function activePlayers(room) { return room.players.filter(p => !p.folded && !p.disconnected); }
function publicState(room, viewer) {
  const g = room.game;
  return {
    phase: g ? g.phase : 'lobby', pot: g ? g.pot : 0, lastBlind: g ? g.lastBlind : 5, hostId: room.hostId, isHost: viewer === room.hostId,
    current: g && g.phase === 'playing' ? g.players[g.turn]?.id || null : null,
    currentName: g && g.phase === 'playing' ? g.players[g.turn]?.name || null : null,
    firstSeenId: g ? (g.firstSeenId || null) : null,
    eligibleTargets: g && g.phase === 'playing' ? (g.players[g.turn]?.id === viewer && g.firstSeenId !== viewer ? g.players.filter(q => q.id !== viewer && !q.folded && !q.disconnected && q.wagered).map(q => ({id:q.id,name:q.name})) : []) : [],
    dealer: room.dealerId || null, dealerName: room.players.find(p => p.id === room.dealerId)?.name || null,
    reveal: !!(g && g.reveal), turnDeadline: g && g.phase === 'playing' ? g.turnDeadline : null, players: room.players.filter(p => !p.disconnected).map(p => ({
      id: p.id, name: p.name, chips: p.chips, folded: !!p.folded, seen: !!p.seen,
      hand: g && g.phase === 'finished' ? p.hand : (p.id === viewer && g && p.seen ? p.hand : undefined)
    }))
  };
}
function broadcast(room, message = '') { for (const p of room.players) if (!p.disconnected) send(p, { type: 'state', state: publicState(room, p.id), message }); }
const TURN_MS = 30_000;
function clearTurnTimer(g) { if (g && g.turnTimer) { clearTimeout(g.turnTimer); g.turnTimer = null; } }
function transferForcedBlind(room, leavingPlayer) {
  const g = room.game;
  if (!g || g.forcedBlindId !== leavingPlayer.id) return;
  const startIndex = g.players.indexOf(leavingPlayer);
  g.forcedBlindId = null;
  for (let step = 1; step <= g.players.length; step++) {
    const candidate = g.players[(startIndex + step) % g.players.length];
    if (!candidate.folded && !candidate.disconnected) { g.forcedBlindId = candidate.id; return; }
  }
}
function armTurnTimer(room) {
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  clearTurnTimer(g);
  const p = g.players[g.turn];
  if (!p) return;
  g.turnDeadline = Date.now() + TURN_MS;
  g.turnTimer = setTimeout(() => {
    if (room.game !== g || g.phase !== 'playing' || g.players[g.turn] !== p || p.folded || p.disconnected) return;
    p.folded = true;
    transferForcedBlind(room, p);
    const alive = activePlayers(room);
    if (alive.length <= 1) finish(room, alive[0] || null, `${p.name} 超时未操作，自动弃牌。${alive[0] ? alive[0].name + ' 赢得本局。' : '本局无人获胜。'}`);
    else { advance(room); armTurnTimer(room); broadcast(room, `${p.name} 30 秒内未完成操作，自动弃牌。`); }
  }, TURN_MS);
  if (typeof g.turnTimer.unref === 'function') g.turnTimer.unref();
}
function findRoomByPlayer(id) { for (const r of rooms.values()) if (r.players.some(p => p.id === id && !p.disconnected)) return r; return null; }
function advance(room) {
  const g = room.game;
  if (!g || !g.players.length) return;
  for (let k = 1; k <= g.players.length; k++) {
    const i = (g.turn + k) % g.players.length;
    if (!g.players[i].folded && !g.players[i].disconnected) { g.turn = i; return; }
  }
}
function finish(room, winner, message) {
  const g = room.game; if (!g || g.phase !== 'playing') return;
  clearTurnTimer(g); g.turnDeadline = null; g.phase = 'finished'; g.reveal = true;
  if (winner) {
    winner.chips += g.pot;
    room.dealerId = winner.id; // The winner becomes the next hand's dealer, even if the old dealer folded.
    const ev = evaluate(winner.hand);
    const others = room.players.filter(p => p.id !== winner.id && !p.disconnected);
    const bonus = ((ev.cat === 6 || ev.cat === 8) && winner.everBlinded) || (ev.cat === 7 && winner.everBlinded && activePlayers(room).length === 1 && !g.hadShowdown);
    if (bonus) {
      // 固定每位其他玩家支付 30 分；允许筹码变为负数。
      let extra = 0;
      for (const other of others) { other.chips -= 30; extra += 30; }
      winner.chips += extra;
      message += ` 喜牌奖励：从其他玩家处获得 ${extra} 分（每人固定支付 30 分）。`;
    }
  }
  broadcast(room, message || '本局结束。');
}
function terminate(room, player) {
  if (!room || room.hostId !== player.id) return { ok: false, message: '只有房主可以关闭房间。' };
  const g = room.game;
  if (g && g.phase === 'playing') return { ok: false, message: '牌局进行中不能关闭房间，请等本局结束。' };
  rooms.delete(room.code);
  return { ok: true };
}
function start(room) {
  room.players = room.players.filter(p => !p.disconnected);
  if (room.players.length < 2) return broadcast(room, '至少需要两名在线玩家才能开始。');
  // 按已确认规则，筹码可以为负数；不因筹码不足禁止开局。
  const d = deck();
  const players = room.players;
  let dealerIndex = players.findIndex(p => p.id === room.dealerId);
  if (dealerIndex < 0) dealerIndex = crypto.randomInt(players.length); // Random dealer for the first hand.
  room.dealerId = players[dealerIndex].id;
  const g = room.game = { phase: 'playing', pot: 0, lastBlind: 5, turn: (dealerIndex + 1) % players.length, reveal: false, players, round: (room.game?.round || 0) + 1, firstSeenId: null, contributions: Object.create(null), forcedBlindId: players[(dealerIndex + 1) % players.length].id };
  for (const p of players) {
    p.hand = d.splice(0, 3); p.folded = false; p.seen = false; p.blind = false; p.everBlinded = false; p.wagered = false;
    const ante = 5; p.chips -= ante; g.pot += ante; g.contributions[p.id] = ante;
  }
  armTurnTimer(room); broadcast(room, `第 ${g.round} 局开始：${room.players[dealerIndex].name} 坐庄，从庄家下一位开始行动。每人先支付 5 分底注。`);
}
function action(room, p, m) {
  const g = room.game;
  if (g && !g.contributions) g.contributions = Object.create(null);
  if (!g || g.phase !== 'playing') return send(p, { type: 'error', message: '当前没有进行中的牌局。' });
  if (g.players[g.turn] !== p) return send(p, { type: 'error', message: '还没轮到你行动。' });
  if (p.folded) return;
  if (m.action === 'fold') {
    if (g.forcedBlindId === p.id) return send(p, { type: 'error', message: '你是本局强制闷牌玩家，必须先闷牌，不能主动弃牌。' });
    p.folded = true;
    transferForcedBlind(room, p);
    const alive = activePlayers(room);
    if (alive.length === 1) return finish(room, alive[0], `${p.name} 弃牌，${alive[0].name} 成为最后一位未弃牌玩家，赢得底池。`);
    advance(room); armTurnTimer(room); return broadcast(room, `${p.name} 弃牌。`);
  }
  if (m.action === 'look') {
    if (p.seen) return send(p, { type: 'error', message: '你已经看过自己的牌了。' });
    p.seen = true;
    if (!g.firstSeenId) g.firstSeenId = p.id;
    return broadcast(room, `${p.name} 看了自己的牌。`);
  }
  if (m.action === 'blindShow') {
    const aliveNow = activePlayers(room);
    if (aliveNow.length !== 2) return send(p, { type: 'error', message: '只有场上最后两名玩家时，才能使用闷牌比牌。' });
    if (p.seen) return send(p, { type: 'error', message: '你已经看牌，不能使用闷牌比牌。' });
    const target = aliveNow.find(q => q.id !== p.id && q.wagered && q.id === m.target);
    if (!target) return send(p, { type: 'error', message: '只能闷牌挑战最后一名仍在局内且已下注的对手。' });
    if (g.forcedBlindId === p.id) return send(p, { type: 'error', message: '你必须先完成本局强制闷牌，不能直接比牌。' });
    g.hadShowdown = true;
    const amount = g.lastBlind;
    p.chips -= amount; g.pot += amount; g.contributions[p.id] = (g.contributions[p.id] || 0) + amount;
    const won = compareHands(p.hand, target.hand) > 0;
    const loser = won ? target : p;
    loser.folded = true;
    return finish(room, won ? p : target, `${p.name} 支付 ${amount} 分闷牌比牌，${won ? '挑战成功' : '挑战失败'}，${(won ? p : target).name} 赢得本局。`);
  }
  if (m.action === 'show') {
    if (!p.seen) return send(p, { type: 'error', message: '看牌后才能发起普通比牌。' });
    if (g.firstSeenId === p.id) return send(p, { type: 'error', message: '第一位看牌的玩家只能下注或弃牌，不能比牌。' });
    const target = g.players.find(q => q.id === m.target && !q.folded && !q.disconnected && q.id !== p.id && q.wagered);
    if (!target) return send(p, { type: 'error', message: '只能选择之前已经上过牌且仍在局内的玩家比牌。' });
    g.hadShowdown = true;
    const amount = g.lastBlind * 2;
    // 允许筹码不足，支付后可以变为负数。
    p.chips -= amount; g.pot += amount; g.contributions[p.id] = (g.contributions[p.id] || 0) + amount;
    const won = compareHands(p.hand, target.hand) > 0;
    const loser = won ? target : p;
    loser.folded = true;
    const alive = activePlayers(room);
    if (alive.length === 1) return finish(room, alive[0], `${p.name} 支付 ${amount} 分与 ${target.name} 比牌，${won ? '比牌获胜' : '比牌失败'}，赢得本局。`);
    advance(room); armTurnTimer(room);
    return broadcast(room, `${p.name} 支付 ${amount} 分与 ${target.name} 比牌，${won ? p.name+' 获胜，'+target.name+' 淘汰。' : p.name+' 失败并被淘汰。'}`);
  }
  const amount = Number(m.amount);
  if (!Number.isFinite(amount) || ![5, 10, 15, 20, 30].includes(amount)) return send(p, { type: 'error', message: '下注金额不合法。' });
  if (m.action === 'blind') {
    if (p.seen) return send(p, { type: 'error', message: '看过牌后不能再闷牌。' });
    if (![5, 10, 15].includes(amount) || amount < g.lastBlind) return send(p, { type: 'error', message: '闷注只能选 5/10/15，且不能低于当前有效闷注。' });
    if (g.forcedBlindId && p.id !== g.forcedBlindId) return send(p, { type: 'error', message: '当前玩家必须先完成强制闷牌。' });
  } else if (m.action === 'seen') {
    if (g.forcedBlindId === p.id) return send(p, { type: 'error', message: '你必须先成功闷牌，才能看牌下注。' });
    if (![10, 20, 30].includes(amount) || amount < g.lastBlind * 2) return send(p, { type: 'error', message: '看牌下注必须为当前闷注的两倍或以上。' });
  } else return send(p, { type: 'error', message: '未知操作。' });
  // 允许筹码不足，支付后可以变为负数。
  p.chips -= amount; g.pot += amount; g.contributions[p.id] = (g.contributions[p.id] || 0) + amount;
  if (m.action === 'blind') { g.lastBlind = amount; p.blind = true; p.everBlinded = true; p.seen = false; if (g.forcedBlindId === p.id) g.forcedBlindId = null; }
  else { g.lastBlind = amount / 2; p.seen = true; if (!g.firstSeenId) g.firstSeenId = p.id; }
  p.wagered = true;
  const name = p.name, actionText = m.action === 'blind' ? '闷牌下注' : '看牌下注';
  const alive = activePlayers(room);
  if (alive.length === 1) return finish(room, alive[0], `${name} ${actionText} ${amount} 分。`);
  advance(room); armTurnTimer(room); broadcast(room, `${name} ${actionText} ${amount} 分。`);
}

wss.on('connection', ws => {
  const player = { ws, id: crypto.randomUUID(), name: '玩家', chips: 300, folded: false, seen: false, blind: true, disconnected: false };
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return send(player, { type: 'error', message: '消息格式错误。' }); }
    if (m.type === 'create') {
      const code = crypto.randomBytes(3).toString('hex').toUpperCase();
      const room = { code, players: [], game: null, dealerId: null, hostId: player.id, bannedNames: new Set() };
      rooms.set(code, room); player.name = String(m.name || '玩家').slice(0, 16); room.players.push(player);
      send(player, { type: 'welcome', id: player.id, room: code, message: '房间创建成功，把房间号分享给好友。' }); broadcast(room, '等待好友加入。');
    } else if (m.type === 'join') {
      const code = String(m.room || '').toUpperCase(), room = rooms.get(code);
      if (!room) return send(player, { type: 'error', message: '房间不存在，请确认房间号。' });
      const requestedName = String(m.name || '玩家').slice(0, 16);
      if (room.bannedNames && room.bannedNames.has(requestedName)) return send(player, { type: 'error', message: '该玩家已断线退出，不能重新进入此房间。' });
      if (room.players.filter(p => !p.disconnected).length >= 8) return send(player, { type: 'error', message: '房间已满，最多 8 人。' });
      if (room.game && room.game.phase === 'playing') return send(player, { type: 'error', message: '牌局进行中，暂时不能加入。' });
      player.name = requestedName; room.players.push(player);
      send(player, { type: 'welcome', id: player.id, room: code, message: '加入成功，等待房主开始。' }); broadcast(room, `${player.name} 加入了房间。`);
    } else if (m.type === 'ready') {
      const room = findRoomByPlayer(player.id);
      if (!room) return send(player, { type: 'error', message: '请先创建或加入房间。' });
      if (room.game && room.game.phase === 'playing') return send(player, { type: 'error', message: '本局尚未结束。' });
      if (room.hostId !== player.id) return send(player, { type: 'error', message: '请由房主点击开始。' });
      start(room);
    } else if (m.type === 'terminate') {
      const room = findRoomByPlayer(player.id);
      if (!room) return send(player, { type: 'error', message: '请先创建或加入房间。' });
      const result = terminate(room, player);
      if (!result.ok) return send(player, { type: 'error', message: result.message });
    } else if (m.type === 'action') {
      const room = findRoomByPlayer(player.id); if (room) action(room, player, m);
    }
  });
  ws.on('close', () => {
    if (player.disconnected) return;
    player.disconnected = true;
    const found = [...rooms.values()].find(r => r.players.some(p => p.id === player.id));
    if (!found) return;
    if (!found.bannedNames) found.bannedNames = new Set();
    found.bannedNames.add(player.name);
    const g = found.game;
    if (g && g.phase === 'playing') {
      player.folded = true; // 已投入筹码留在底池，不退款。
      transferForcedBlind(found, player);
      found.players = found.players.filter(p => p.id !== player.id);
      const alive = activePlayers(found);
      if (alive.length <= 1) finish(found, alive[0] || null, `${player.name} 断线退出，已下注筹码留在奖池；${alive[0] ? alive[0].name + ' 赢得底池。' : '本局无人获胜。'}`);
      else {
        if (g.players[g.turn] === player) advance(found);
        // If the removed player was not the current actor, retain the current turn;
        // if the turn index now points at a folded/disconnected seat, advance safely.
        let current = g.players[g.turn];
        if (!current || current.folded || current.disconnected) advance(found);
        armTurnTimer(found);
        broadcast(found, `${player.name} 断线退出，自动弃牌，已下注筹码留在奖池。`);
      }
      if (found.hostId === player.id) {
        const successor = found.players.find(p => !p.disconnected);
        if (successor) found.hostId = successor.id;
      }
    } else {
      found.players = found.players.filter(p => p.id !== player.id);
      if (!found.players.length) rooms.delete(found.code);
      else {
        if (found.hostId === player.id) found.hostId = found.players[0].id;
        broadcast(found, `${player.name} 断线退出房间。`);
      }
    }
  });
});
if (require.main === module) server.listen(PORT, () => console.log(`炸金花服务器已启动：http://localhost:${PORT}`));
module.exports = { evaluate, compareHands, deck, start, action, finish, terminate, activePlayers, publicState, server, wss, rooms };
