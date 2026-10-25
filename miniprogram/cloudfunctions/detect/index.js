// ============================================================
// detect 云函数 —— 侦探社
//
// 一、直接提问
//    问题 → 元宝搜索（经你已部署的 Cloudflare Worker）→ 原文摘要 + 证据链接
//
// 二、真假答题（单人 / 双人）
//    不预设题库：现场用元宝搜索出题（出题规则见 quiz.js）
//      1) 按类型或自填主题搜一轮，只取 official / academic / media 来源；
//      2) 从权威摘要里摘一句事实短句 = 「真的」；
//      3) 改数字 / 加否定词 = 「假的」（谣言最常见的形态）；
//      4) 揭晓时给：真/假 + 原句 + 来源（含分级标签）。
//    双人同场各自选、都选完才揭晓，最后一分高者得小红花；单人也能玩。
// ============================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const https = require('https');
const config = require('./config.js');
const QZ = require('./quiz.js');
const A = require('./answer.js');

const INTERNAL_SECRET = 'hsmp-internal-flower-2026';
const ROOMS = 'detectRooms';
const ALLOWED = config.ALLOWED_TIERS || QZ.DEFAULT_TIERS;

/* ---------------- HTTP ---------------- */
function requestJson(method, urlStr, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('地址不合法')); }
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = payload.length;
    }
    if (config.WORKER_TOKEN) headers.Authorization = 'Bearer ' + config.WORKER_TOKEN;

    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + (u.search || ''),
      headers, timeout: timeoutMs || config.TIMEOUT_MS
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); }
        catch (e) { return reject(new Error('搜索服务返回异常（HTTP ' + res.statusCode + '）')); }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('timeout', () => req.destroy(new Error('搜索超时，稍后再试')));
    req.on('error', (e) => reject(new Error('连不上搜索服务：' + (e.message || e))));
    if (payload) req.write(payload);
    req.end();
  });
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/* ---------------- 元宝搜索 ---------------- */
async function searchWeb(q, cnt) {
  const word = clean(q).slice(0, 200);
  if (!word) throw new Error('问题不能为空');
  const url = config.SEARCH_BASE + '/api/search?q=' + encodeURIComponent(word) + '&cnt=' + (cnt || 10);
  const r = await requestJson('GET', url);
  const j = (r && r.json) || {};
  if (!j.ok) throw new Error(j.error || ('搜索服务不可用（HTTP ' + r.status + '）'));
  return (j.items || [])
    .filter((x) => x && x.url && (x.passage || x.title))
    .map((x) => ({
      title: clean(x.title).slice(0, 80),
      site: clean(x.site).slice(0, 40),
      url: String(x.url).slice(0, 500),
      date: clean(x.date).slice(0, 20),
      passage: clean(x.passage).slice(0, 500),
      tier: clean(x.tier) || 'vertical'
    }));
}

// 搜索摘要 → 最多 2 句最相关的原文（提炼逻辑在 answer.js；宁可短，别又长又乱）
function composeAnswer(items, q) {
  return A.pickPoints(items, q, 2);
}

// 搜索偶尔会慢/超时（实测 3～28 秒不等）：失败就简化查询再试一次
async function searchRetry(q, cnt) {
  try {
    return await searchWeb(q, cnt);
  } catch (e) {
    const simple = String(q || '').split(' ')[0];
    if (!simple || simple === q) throw e;
    return await searchWeb(simple, Math.min(cnt || 20, 20));
  }
}

/* ---------------- 题目缓存（同一主题 6 小时内直接复用，省一次 10 秒搜索） ---------------- */
const CACHE_COL = 'detectQuizCache';
const CACHE_TTL = 6 * 3600 * 1000;

async function readCache(key) {
  const r = await db.collection(CACHE_COL).where({ key }).limit(1).get().catch(() => null);
  const d = r && (r.data || [])[0];
  if (!d || !(d.questions || []).length) return null;
  const at = d.at ? new Date(d.at).getTime() : 0;
  if (!at || Date.now() - at > CACHE_TTL) return null;
  return d.questions;
}

async function writeCache(key, topic, questions) {
  await db.collection(CACHE_COL).add({
    data: { key, topic, questions, at: db.serverDate(), createdAt: db.serverDate() }
  }).catch(() => {});
}

/* ---------------- 房间工具 ---------------- */
async function getRoom(id) {
  if (!id) return null;
  const r = await db.collection(ROOMS).doc(id).get().catch(() => null);
  return (r && r.data) || null;
}

async function memberOf(spaceId, openid) {
  const r = await db.collection('members').where({ spaceId, openid }).limit(1)
    .get().catch(() => ({ data: [] }));
  return (r.data || [])[0] || null;
}

// 揭晓前绝不返回答案、也不返回对方选了什么
function publicRoom(room, openid) {
  const players = room.players || [];
  const qi = room.qi || 0;
  const revealed = room.phase === 'revealed' || room.status === 'done';
  const q = (room.questions || [])[qi] || null;
  const me = players.find((p) => p.openid === openid) || null;
  const allPicked = players.length > 0 && players.every((p) => p.picks && p.picks[qi] != null);
  return {
    _id: room._id, code: room.code, status: room.status, phase: room.phase,
    mode: room.mode || 'duo',
    topic: room.topic || '', categoryName: room.categoryName || '',
    qi, rounds: room.rounds,
    owner: room.owner, ownerName: room.ownerName || '', isOwner: room.owner === openid,
    players: players.map((p) => ({
      openid: p.openid, name: p.name || '家人', score: p.score || 0,
      isMe: p.openid === openid,
      picked: !!(p.picks && p.picks[qi] != null),
      pick: revealed ? (p.picks ? p.picks[qi] : null) : null
    })),
    question: q ? {
      claim: q.claim,
      answer: revealed ? q.answer : null,
      origin: revealed ? (q.origin || '') : '',
      evidence: revealed ? (q.evidence || []) : []
    } : null,
    myPick: (me && me.picks && me.picks[qi] != null) ? me.picks[qi] : null,
    allPicked,
    winner: room.winner || '', winnerNames: room.winnerNames || [],
    winnerFlowers: room.winnerFlowers || 0, isTie: !!room.isTie,
    finishedAt: room.finishedAt || null
  };
}

// 揭晓当前题：0 = 真的，1 = 假的
async function revealCurrent(room) {
  if (room.phase === 'revealed' || room.status === 'done') return room;
  const qi = room.qi || 0;
  const q = (room.questions || [])[qi];
  if (!q) return room;

  const players = (room.players || []).map((p) => {
    const choice = p.picks ? p.picks[qi] : null;
    const right = choice != null && (choice === 0) === !!q.answer;
    return Object.assign({}, p, { score: (p.score || 0) + (right ? 1 : 0) });
  });
  const revealedAt = Date.now();
  await db.collection(ROOMS).doc(room._id).update({
    data: { players, phase: 'revealed', revealedAt, updatedAt: db.serverDate() }
  }).catch(() => {});
  return Object.assign({}, room, { players, phase: 'revealed', revealedAt });
}

async function grantWin(spaceId, openid, roomId) {
  try {
    const r = await cloud.callFunction({
      name: 'flower',
      data: {
        _token: INTERNAL_SECRET, action: 'earn',
        openid, spaceId, rule: 'detect_win', refId: roomId, label: '侦探社答题获胜'
      }
    });
    const res = (r && r.result) || {};
    return (res.success && res.delta) ? res.delta : 0;
  } catch (e) {
    return 0;
  }
}

/* ---------------- 入口 ---------------- */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;

  try {
    /* 0. 类型列表 */
    if (action === 'categories') {
      return { success: true, categories: QZ.CATEGORIES.map((c) => ({ key: c.key, name: c.name })) };
    }

    /* 1. 直接提问 */
    if (action === 'ask') {
      const q = clean(event.q).slice(0, 200);
      if (!q) return { success: false, errMsg: '先写个问题吧' };
      let items = [];
      try { items = await searchWeb(q, 10); }
      catch (e) { return { success: false, errMsg: (e && e.message) || '搜索失败' }; }
      const ranked = items.slice().sort((a, b) => QZ.tierRank(b.tier) - QZ.tierRank(a.tier));
      const sources = ranked.slice(0, 5).map((x) => ({
        title: x.title, site: x.site, url: x.url, date: x.date, tier: x.tier,
        tierLabel: QZ.TIER_LABEL[x.tier] || '', trusted: QZ.isTrusted(x, ALLOWED)
      }));
      // 只挑 2～3 句最相关的原文，别再把整段摘要糊上来
      const brief = composeAnswer(items, q);
      return {
        success: true, q,
        points: brief.points, answer: brief.answer,
        sources: sources.slice(0, 4), sourceTotal: sources.length, count: items.length,
        trustedCount: sources.filter((x) => x.trusted).length,
        empty: !items.length
      };
    }

    /* 2. 开一场（mode: solo 一个人练 / duo 两人对战） */
    if (action === 'createRoom') {
      const spaceId = event.spaceId;
      const me = await memberOf(spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你不在这个家庭里' };

      const mode = event.mode === 'solo' ? 'solo' : 'duo';
      const rounds = Math.max(2, Math.min(8, parseInt(event.rounds, 10) || config.ROUNDS));

      const catKey = clean(event.category).slice(0, 20);
      const cat = QZ.CATEGORIES.find((c) => c.key === catKey) || null;
      const custom = clean(event.topic).slice(0, 20);
      const topic = custom || (cat ? cat.words : QZ.CATEGORIES[0].words);

      // 同一主题 6 小时内复用题库（家里人同一主题玩多次就不用再等搜索）
      const cacheKey = 'topic:' + topic + ':n' + rounds;
      let questions = await readCache(cacheKey);
      let fromCache = !!questions;
      if (!questions) {
        try {
          questions = await QZ.buildQuiz(searchRetry, topic, rounds, ALLOWED);
        } catch (e) {
          return { success: false, errMsg: (e && e.message) || '出题失败，换个主题试试' };
        }
        if (questions.length) writeCache(cacheKey, topic, questions);   // 不 await，别让用户等存缓存
      }

      // 之前没开局的房间先作废，避免一堆僵尸房间
      await db.collection(ROOMS).where({ spaceId, owner: OPENID, status: 'waiting', mode: 'duo' })
        .remove().catch(() => {});

      let code = String(Math.floor(1000 + Math.random() * 9000));
      for (let i = 0; i < 5; i++) {
        const dup = await db.collection(ROOMS).where({ spaceId, code, status: 'waiting' })
          .count().catch(() => ({ total: 0 }));
        if (!dup.total) break;
        code = String(Math.floor(1000 + Math.random() * 9000));
      }

      const doc = {
        spaceId, code, owner: OPENID, ownerName: me.nickName || '我',
        mode, topic: custom || '', categoryName: cat ? cat.name : '',
        status: mode === 'solo' ? 'playing' : 'waiting',
        startedAt: mode === 'solo' ? Date.now() : null,
        phase: 'picking', qi: 0, rounds: questions.length, questions,
        players: [{
          openid: OPENID, name: me.nickName || '我', score: 0,
          picks: new Array(questions.length).fill(null), joinedAt: Date.now()
        }],
        createdAt: db.serverDate(), updatedAt: db.serverDate()
      };
      const added = await db.collection(ROOMS).add({ data: doc });
      doc._id = added._id;
      return { success: true, roomId: added._id, code, cached: fromCache, room: publicRoom(doc, OPENID) };
    }

    /* 3. 房间号加入（双人） */
    if (action === 'joinRoom') {
      const spaceId = event.spaceId;
      const code = clean(event.code).replace(/\D/g, '').slice(0, 4);
      if (!code) return { success: false, errMsg: '请输入 4 位房间号' };
      const me = await memberOf(spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你不在这个家庭里' };

      const r = await db.collection(ROOMS).where({ spaceId, code, status: 'waiting' })
        .orderBy('createdAt', 'desc').limit(1).get().catch(() => ({ data: [] }));
      const room = (r.data || [])[0];
      if (!room) return { success: false, errMsg: '没找到这场答题（可能已开始或已结束）' };
      if ((room.players || []).some((p) => p.openid === OPENID)) {
        return { success: true, roomId: room._id, room: publicRoom(room, OPENID) };
      }
      if ((room.players || []).length >= config.MAX_PLAYERS) {
        return { success: false, errMsg: '这场已经满 ' + config.MAX_PLAYERS + ' 人了' };
      }

      const players = (room.players || []).concat([{
        openid: OPENID, name: me.nickName || '家人', score: 0,
        picks: new Array(room.questions.length).fill(null), joinedAt: Date.now()
      }]);
      await db.collection(ROOMS).doc(room._id).update({
        data: { players, status: 'playing', startedAt: Date.now(), updatedAt: db.serverDate() }
      });
      const fresh = await getRoom(room._id);
      return { success: true, roomId: room._id, room: publicRoom(fresh || room, OPENID) };
    }

    /* 4. 房间状态（前端轮询） */
    if (action === 'room') {
      const room = await getRoom(event.roomId);
      if (!room) return { success: false, errMsg: '房间不存在' };
      if (room.spaceId !== event.spaceId) return { success: false, errMsg: '无权访问' };
      return { success: true, room: publicRoom(room, OPENID) };
    }

    /* 5. 选答案（0 = 真的，1 = 假的） */
    if (action === 'pick') {
      let room = await getRoom(event.roomId);
      if (!room) return { success: false, errMsg: '房间不存在' };
      if (room.spaceId !== event.spaceId) return { success: false, errMsg: '无权访问' };
      if (room.status !== 'playing') return { success: false, errMsg: '还没开局' };
      if (room.phase === 'revealed') return { success: true, room: publicRoom(room, OPENID), tooLate: true };
      const qi = room.qi || 0;
      const choice = parseInt(event.choice, 10);
      if (choice !== 0 && choice !== 1) return { success: false, errMsg: '选项不合法' };

      let idx = (room.players || []).findIndex((p) => p.openid === OPENID);
      if (idx < 0) return { success: false, errMsg: '你不在这一局里' };
      if (room.players[idx].picks[qi] != null) return { success: true, room: publicRoom(room, OPENID), already: true };

      // 两人可能几乎同时点：重读-写-回读，丢了重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const players = room.players.map((p, i) => {
          if (i !== idx) return p;
          const picks = (p.picks || []).slice();
          picks[qi] = choice;
          return Object.assign({}, p, { picks });
        });
        await db.collection(ROOMS).doc(room._id).update({ data: { players, updatedAt: db.serverDate() } });
        const check = await getRoom(room._id);
        room = check || room;
        const mine = (room.players || []).find((p) => p.openid === OPENID);
        if (mine && mine.picks && mine.picks[qi] === choice) break;
        idx = (room.players || []).findIndex((p) => p.openid === OPENID);
        if (idx < 0) return { success: false, errMsg: '你不在这一局里' };
      }

      const all = (room.players || []).length > 0
        && (room.players || []).every((p) => p.picks && p.picks[room.qi] != null);
      if (all) room = await revealCurrent(room);
      return { success: true, room: publicRoom(room, OPENID) };
    }

    /* 6. 下一题 / 结算 */
    if (action === 'next') {
      let room = await getRoom(event.roomId);
      if (!room) return { success: false, errMsg: '房间不存在' };
      if (room.spaceId !== event.spaceId) return { success: false, errMsg: '无权访问' };
      if (room.status === 'done') return { success: true, room: publicRoom(room, OPENID), done: true };

      if (room.phase !== 'revealed') room = await revealCurrent(room);

      const nextQi = (room.qi || 0) + 1;
      if (nextQi >= room.rounds) {
        const players = room.players || [];
        const top = Math.max.apply(null, players.map((p) => p.score || 0));
        const winners = players.filter((p) => (p.score || 0) === top);
        // 单人模式：必须全对才发花（给自己一个目标）；双人：分数唯一最高者获胜
        const isTie = room.mode === 'solo'
          ? (top !== room.rounds)
          : (winners.length !== 1 || top === 0);
        let gained = 0;
        if (!isTie) gained = await grantWin(room.spaceId, winners[0].openid, room._id);
        await db.collection(ROOMS).doc(room._id).update({
          data: {
            status: 'done', phase: 'revealed',
            winner: isTie ? '' : winners[0].openid,
            winnerNames: isTie ? [] : [winners[0].name || '家人'],
            winnerFlowers: gained, isTie,
            finishedAt: Date.now(), updatedAt: db.serverDate()
          }
        });
        const fresh = await getRoom(room._id);
        return { success: true, room: publicRoom(fresh || room, OPENID), done: true, gained };
      }

      await db.collection(ROOMS).doc(room._id).update({
        data: { qi: nextQi, phase: 'picking', updatedAt: db.serverDate() }
      });
      const fresh = await getRoom(room._id);
      return { success: true, room: publicRoom(fresh || room, OPENID) };
    }

    /* 7. 最近的局 */
    if (action === 'rooms') {
      const r = await db.collection(ROOMS).where({ spaceId: event.spaceId })
        .orderBy('createdAt', 'desc').limit(10).get().catch(() => ({ data: [] }));
      const list = (r.data || []).map((x) => ({
        _id: x._id, code: x.code, status: x.status, mode: x.mode || 'duo',
        qi: (x.qi || 0) + 1, rounds: x.rounds, ownerName: x.ownerName || '',
        categoryName: x.categoryName || x.topic || '',
        playerNames: (x.players || []).map((p) => p.name || '家人'),
        isMine: (x.players || []).some((p) => p.openid === OPENID)
      }));
      return { success: true, list };
    }

    /* 8. 关闭 / 退出 */
    if (action === 'closeRoom') {
      const room = await getRoom(event.roomId);
      if (!room) return { success: true };
      if (room.spaceId !== event.spaceId) return { success: false, errMsg: '无权访问' };
      if (room.status === 'waiting') await db.collection(ROOMS).doc(room._id).remove().catch(() => {});
      return { success: true };
    }

    return { success: false, errMsg: '未知操作' };
  } catch (e) {
    return { success: false, errMsg: (e && (e.errMsg || e.message)) || String(e) };
  }
};
