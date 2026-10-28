'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Stub the WebSocket transport so game rules can be tested offline without npm downloads.
const Module = require('node:module');
const originalLoad = Module._load;
class FakeWebSocketServer { on() {} }
Module._load = function(request, parent, isMain) {
  if (request === 'ws') return { Server: FakeWebSocketServer, OPEN: 1 };
  return originalLoad.call(this, request, parent, isMain);
};
const { evaluate, compareHands, start, action, finish, terminate, publicState } = require('./server');
Module._load = originalLoad;
const hand = (ranks, suits = ['♠','♥','♣']) => ranks.map((r,i)=>({r,s:suits[i]}));
function player(id, name=id, chips=500) { return { id, name, chips, ws: null, folded:false, seen:false, blind:true, disconnected:false }; }

test('235 beats every trips including AAA, but loses to all ordinary hands', () => {
  const special = hand([2,3,5]);
  assert.equal(evaluate(special).label, '特殊牌 235');
  for (const r of [2,7,13,14]) assert.ok(compareHands(special, hand([r,r,r])) > 0, `235 should beat ${r}${r}${r}`);
  assert.ok(compareHands(special, hand([9,10,11], ['♠','♠','♠'])) < 0);
  assert.equal(compareHands(special, hand([2,3,5], ['♠','♠','♠'])), 0); // both are the special 235 hand
  assert.ok(compareHands(special, hand([2,4,7])) < 0); // loses to ordinary high card
});
test('AAA is the strongest ordinary trips', () => {
  assert.ok(compareHands(hand([14,14,14]), hand([13,13,13])) > 0);
  assert.ok(compareHands(hand([13,13,13]), hand([12,12,12])) > 0);
});
test('dealer starts; actions move one seat at a time in circular order', () => {
  const a=player('a','A'), b=player('b','B'), c=player('c','C');
  const room={players:[a,b,c],game:null,dealerId:'b'};
  start(room);
  assert.equal(room.game.players[room.game.turn].id, 'c');
  action(room,c,{action:'blind',amount:5});
  assert.equal(room.game.players[room.game.turn].id, 'a');
  action(room,a,{action:'blind',amount:5});
  assert.equal(room.game.players[room.game.turn].id, 'b');
  action(room,b,{action:'blind',amount:5});
  assert.equal(room.game.players[room.game.turn].id, 'c');
});
test('winner becomes next dealer, even when previous dealer folded', () => {
  const a=player('a','A'), b=player('b','B'), c=player('c','C');
  const room={players:[a,b,c],game:{phase:'playing',pot:15,reveal:false,players:[a,b,c],turn:0},dealerId:'a'};
  a.hand=hand([2,4,7]); b.hand=hand([14,14,14]); c.hand=hand([3,6,9]);
  a.folded=true; finish(room,b,'B wins');
  assert.equal(room.dealerId,'b');
  assert.equal(room.game.phase,'finished');
});
test('public state hides other players cards until hand finishes', () => {
  const a=player('a','A'), b=player('b','B'); a.hand=hand([2,3,4]); b.hand=hand([8,9,10]);
  const room={players:[a,b],dealerId:'a',game:{phase:'playing',pot:10,lastBlind:5,turn:0,reveal:false,players:[a,b]}};
  const state=publicState(room,'a');
  assert.ok(state.players.find(p=>p.id==='a').hand);
  assert.equal(state.players.find(p=>p.id==='b').hand,undefined);
});
test('invalid low blind bet is rejected without changing pot or chips', () => {
  const a=player('a','A'), b=player('b','B');
  const room={players:[a,b],dealerId:'a',game:{phase:'playing',pot:10,lastBlind:10,reveal:false,players:[a,b],turn:0}};
  a.hand=hand([2,4,7]); b.hand=hand([3,6,9]);
  const before=a.chips;
  action(room,a,{action:'blind',amount:5});
  assert.equal(room.game.pot,10);
  assert.equal(a.chips,before);
  assert.equal(room.game.turn,0);
});

test('first player to look cannot challenge; rejected action changes nothing', () => {
  const a=player('a','A'), b=player('b','B'), c=player('c','C');
  a.hand=hand([14,14,14]); b.hand=hand([13,13,13]); c.hand=hand([2,4,7]);
  const room={players:[a,b,c],dealerId:'a',game:{phase:'playing',pot:30,lastBlind:10,reveal:false,players:[a,b,c],turn:0,firstSeenId:'a'}};
  a.seen=true; b.wagered=true; a.chips=100;
  action(room,a,{action:'show',target:'b'});
  assert.equal(a.chips,100);
  assert.equal(room.game.pot,30);
  assert.equal(b.folded,false);
  assert.equal(room.game.turn,0);
});

test('later seen player can challenge only a prior bettor; loser folds and turn advances', () => {
  const a=player('a','A'), b=player('b','B'), c=player('c','C');
  a.hand=hand([14,14,14]); b.hand=hand([13,13,13]); c.hand=hand([2,4,7]);
  const room={players:[a,b,c],dealerId:'a',game:{phase:'playing',pot:30,lastBlind:10,reveal:false,players:[a,b,c],turn:1,firstSeenId:'a'}};
  a.seen=true; a.wagered=true; b.seen=true; b.wagered=true; c.wagered=false;
  action(room,b,{action:'show',target:'a'});
  assert.equal(b.folded,true); // KKK loses to AAA
  assert.equal(a.folded,false);
  assert.equal(room.game.pot,50); // challenge costs 2 x last blind
  assert.equal(b.chips,480);
  assert.equal(room.game.turn,2);
});

test('challenge against a player who has not bet is rejected', () => {
  const a=player('a','A'), b=player('b','B');
  a.hand=hand([14,14,14]); b.hand=hand([13,13,13]);
  const room={players:[a,b],dealerId:'a',game:{phase:'playing',pot:10,lastBlind:5,reveal:false,players:[a,b],turn:0,firstSeenId:'b'}};
  a.seen=true; a.wagered=false; b.wagered=false; a.chips=100;
  action(room,a,{action:'show',target:'b'});
  assert.equal(room.game.pot,10);
  assert.equal(a.chips,100);
  assert.equal(b.folded,false);
});


test('each player starts with 300 points and pays exactly 5 ante', () => {
  const a=player('a','A',300), b=player('b','B',300);
  const room={players:[a,b],game:null,dealerId:'a',hostId:'a'};
  start(room);
  assert.equal(a.chips,295); assert.equal(b.chips,295); assert.equal(room.game.pot,10);
});

test('host cannot terminate a hand while it is playing', () => {
  const a=player('a','A',300), b=player('b','B',300);
  const room={players:[a,b],game:null,dealerId:'a',hostId:'a'};
  start(room);
  action(room,b,{action:'blind',amount:5});
  const result=terminate(room,a);
  assert.equal(result.ok,false); assert.equal(room.game.phase,'playing');
  assert.equal(room.game.pot,15); assert.equal(a.chips,295); assert.equal(b.chips,290);
});
test('non-host cannot terminate a hand', () => {
  const a=player('a','A',300), b=player('b','B',300);
  const room={players:[a,b],game:null,dealerId:'a',hostId:'a'};
  start(room); const before=room.game.pot;
  const result=terminate(room,b);
  assert.equal(result.ok,false); assert.equal(room.game.phase,'playing'); assert.equal(room.game.pot,before);
});

test('blind winning special hand transfers bonus from other players', () => {
  const a=player('a','A',295), b=player('b','B',295), c=player('c','C',295);
  const room={players:[a,b,c],dealerId:'a',hostId:'a',game:{phase:'playing',pot:15,reveal:false,players:[a,b,c],turn:0,contributions:{a:5,b:5,c:5}}};
  a.hand=hand([2,3,5]); b.hand=hand([2,4,7]); c.hand=hand([3,6,9]); a.blind=true; a.everBlinded=true; a.folded=false; b.folded=true; c.folded=true;
  finish(room,a,'A wins');
  assert.equal(b.chips,265); assert.equal(c.chips,265);
  assert.equal(a.chips,370);
});

test('forced blind player cannot choose seen-bet before successfully blinding', () => {
  const a=player('a','A'), b=player('b','B');
  const room={players:[a,b],dealerId:'b',game:{phase:'playing',pot:10,lastBlind:5,turn:0,players:[a,b],forcedBlindId:'a',firstSeenId:null,contributions:{a:5,b:5}}};
  const before=a.chips;
  action(room,a,{action:'seen',amount:10});
  assert.equal(a.chips,before);
  assert.equal(room.game.pot,10);
  assert.equal(room.game.forcedBlindId,'a');
});

test('forced blind player cannot voluntarily fold before completing the required blind', () => {
  const a=player('a','A'), b=player('b','B'), c=player('c','C');
  const room={players:[a,b,c],dealerId:'c',game:{phase:'playing',pot:15,lastBlind:5,turn:0,players:[a,b,c],forcedBlindId:'a',firstSeenId:null,contributions:{a:5,b:5,c:5}}};
  const beforePot=room.game.pot;
  action(room,a,{action:'fold'});
  assert.equal(a.folded,false);
  assert.equal(room.game.forcedBlindId,'a');
  assert.equal(room.game.pot,beforePot);
  assert.equal(room.game.turn,0);
});


test('seen player cannot return to blind betting', () => {
  const a=player('a','A'), b=player('b','B');
  const room={players:[a,b],dealerId:'b',game:{phase:'playing',pot:10,lastBlind:5,turn:0,players:[a,b],forcedBlindId:null,firstSeenId:'a',contributions:{a:5,b:5}}};
  a.seen=true; const before=a.chips;
  action(room,a,{action:'blind',amount:5});
  assert.equal(a.chips,before); assert.equal(room.game.pot,10); assert.equal(room.game.turn,0);
});

test('seen bet updates effective blind for following actions', () => {
  const a=player('a','A'), b=player('b','B'), c=player('c','C');
  const room={players:[a,b,c],dealerId:'c',game:{phase:'playing',pot:15,lastBlind:5,turn:0,players:[a,b,c],forcedBlindId:null,firstSeenId:null,contributions:{a:5,b:5,c:5}}};
  action(room,a,{action:'seen',amount:20});
  assert.equal(room.game.lastBlind,10);
  assert.equal(room.game.pot,35);
});
