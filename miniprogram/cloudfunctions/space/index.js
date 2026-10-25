const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const spacesCol = db.collection('spaces');
const membersCol = db.collection('members');
const usersCol = db.collection('users');
const config = require('./config.js');
const TRIAL_DAYS = (config && config.VIRTUAL_PAY && config.VIRTUAL_PAY.trialDays) || 30;

// 生成 6 位邀请码（数字+大写字母，排除易混字符）
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 检查某用户是否是某空间成员
async function isMember(spaceId, openid) {
  const r = await membersCol.where({ spaceId, openid }).count();
  return r.total > 0;
}

// 读全局用户资料（不存在返回 null）
async function getUser(openid) {
  try {
    const r = await usersCol.doc(openid).get();
    return r.data || null;
  } catch (e) {
    return null;
  }
}

// 写全局用户资料（不存在则新建）
async function upsertUser(openid, patch) {
  const exists = !!(await getUser(openid));
  if (exists) {
    await usersCol.doc(openid).update({ data: Object.assign({ updatedAt: db.serverDate() }, patch) });
  } else {
    await usersCol.add({
      data: Object.assign({
        _id: openid, openid, nickName: '', avatarUrl: '',
        bg: { type: 'default', value: '' },
        bgUnlock: false, notifyOn: true,
        memberUntil: Date.now() + TRIAL_DAYS * 86400000,   // 新用户免费试用
        createdAt: db.serverDate(), updatedAt: db.serverDate()
      }, patch)
    });
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;
  try {
    if (action === 'create') {
      const type = event.type; // 仅 'family'（班级空间已下线）
      const name = (event.name || '').trim();
      if (type !== 'family') return { success: false, errMsg: '空间类型不正确' };
      if (!name) return { success: false, errMsg: '请填写名称' };
      // 生成唯一邀请码
      let code = genCode(), tries = 0;
      while (tries < 10) {
        const exist = await spacesCol.where({ inviteCode: code }).count();
        if (exist.total === 0) break;
        code = genCode(); tries++;
      }
      const space = await spacesCol.add({
        data: {
          type, name, ownerOpenid: OPENID, inviteCode: code,
          notice: '', createdAt: db.serverDate()
        }
      });
      await membersCol.add({
        data: {
          spaceId: space._id, openid: OPENID,
          nickName: event.nickName || '户主', avatarUrl: event.avatarUrl || '',
          flowers: 0, role: 'owner', joinAt: db.serverDate()
        }
      });
      return { success: true, spaceId: space._id, inviteCode: code };
    }

    if (action === 'join') {
      const code = (event.inviteCode || '').toUpperCase().trim();
      if (!code) return { success: false, errMsg: '请输入邀请码' };
      const sp = await spacesCol.where({ inviteCode: code }).get();
      if (!sp.data.length) return { success: false, errMsg: '邀请码无效' };
      const spaceId = sp.data[0]._id;
      if (await isMember(spaceId, OPENID)) return { success: false, errMsg: '你已在该空间内' };
      await membersCol.add({
        data: {
          spaceId, openid: OPENID,
          nickName: event.nickName || '成员', avatarUrl: event.avatarUrl || '',
          flowers: 0, role: 'member', joinAt: db.serverDate()
        }
      });
      return { success: true, spaceId };
    }

    if (action === 'list') {
      const mine = await membersCol.where({ openid: OPENID }).get();
      const ids = mine.data.map(m => m.spaceId);
      const spaces = ids.length ? (await spacesCol.where({ _id: _.in(ids) }).get()).data : [];
      const result = spaces.map(s => {
        const m = mine.data.find(x => x.spaceId === s._id);
        return {
          _id: s._id, type: s.type, name: s.name, inviteCode: s.inviteCode,
          notice: s.notice, role: m ? m.role : 'member',
          flowers: m ? (m.flowers || 0) : 0,
          joinAt: m ? m.joinAt : null,
          // 家庭背景图：全家共用。是否可用由前端按「会员是否有效」判断（会员期内一直可用）
          bgImage: s.bgImage || '', bgImageAt: s.bgImageAt || 0, bgImageBy: s.bgImageBy || ''
        };
      });
      return { success: true, openid: OPENID, spaces: result };
    }

    if (action === 'info') {
      const s = await spacesCol.doc(event.spaceId).get();
      const mc = await membersCol.where({ spaceId: event.spaceId }).count();
      const me = await membersCol.where({ spaceId: event.spaceId, openid: OPENID }).get();
      if (!me.data.length) return { success: false, errMsg: '无权访问该空间' };
      return { success: true, space: s.data, memberCount: mc.total, role: me.data[0].role };
    }

    if (action === 'members') {
      if (!(await isMember(event.spaceId, OPENID))) return { success: false, errMsg: '无权访问' };
      const ms = await membersCol.where({ spaceId: event.spaceId }).orderBy('joinAt', 'asc').get();
      // 头像昵称回退到 users 全局资料：早期加入的成员 members 表里没有头像，
      // 不回退的话成员列表/资料卡就会显示空白头像和「成员」
      const ids = (ms.data || []).map(x => x.openid).filter(Boolean);
      let users = [];
      if (ids.length) {
        try {
          users = (await db.collection('users').where({ _id: _.in(ids) }).limit(100).get()).data || [];
        } catch (e) { users = []; }
      }
      const members = (ms.data || []).map(x => {
        const u = users.find(y => y._id === x.openid) || {};
        return Object.assign({}, x, {
          nickName: x.nickName || u.nickName || '成员',
          avatarUrl: x.avatarUrl || u.avatarUrl || ''
        });
      });
      return { success: true, members };
    }

    // 读某个成员的资料卡（空间内互相可见）
    if (action === 'profile') {
      if (!(await isMember(event.spaceId, OPENID))) return { success: false, errMsg: '无权访问' };
      const target = event.targetOpenid || OPENID;
      const m = (await membersCol.where({ spaceId: event.spaceId, openid: target }).limit(1).get()).data[0];
      if (!m) return { success: false, errMsg: '该成员不在这个空间' };
      const u = await getUser(target);
      // 最近 7 天的贡献（发到的花）
      const since = new Date(Date.now() - 7 * 86400000);
      // 加上限：7 天流水可能很多，全量拉取是「点成员卡要等一下」的主因
      const logs = (await db.collection('flowerLogs')
        .where({ spaceId: event.spaceId, openid: target, delta: _.gt(0), createdAt: _.gte(since) })
        .limit(200)
        .get()).data;
      const totalGain = logs.reduce((s, x) => s + (x.delta || 0), 0);
      return {
        success: true,
        profile: {
          openid: target,
          nickName: m.nickName || (u && u.nickName) || '成员',
          avatarUrl: m.avatarUrl || (u && u.avatarUrl) || '',
          role: m.role || 'member',
          flowers: m.flowers || 0,
          earnedTotal: m.earnedTotal || 0,
          joinAt: m.joinAt || null,
          isMe: target === OPENID,
          recent: { count: logs.length, gain: totalGain },
          recentLogs: logs.slice(-8).reverse().map(x => ({ label: x.label, delta: x.delta, at: x.createdAt }))
        }
      };
    }

    // 我自己的全局资料（头像 / 昵称 / 背景 / 会员）
    if (action === 'me') {
      const u = await getUser(OPENID);
      return { success: true, openid: OPENID, user: u || null };
    }

    // 更新我的资料：微信头像 / 昵称 / 自定义背景
    if (action === 'updateProfile') {
      const patch = {};
      if (typeof event.nickName === 'string' && event.nickName.trim()) patch.nickName = event.nickName.trim().slice(0, 24);
      if (typeof event.avatarUrl === 'string' && event.avatarUrl) patch.avatarUrl = event.avatarUrl;
      if (event.bg && typeof event.bg === 'object') patch.bg = event.bg;
      if (event.bgPlaces && typeof event.bgPlaces === 'object') patch.bgPlaces = event.bgPlaces;
      if (!Object.keys(patch).length) return { success: false, errMsg: '没有要更新的内容' };
      await upsertUser(OPENID, patch);
      // 同步到当前空间的成员记录，这样成员列表 / 排行榜能直接显示头像昵称
      if (event.spaceId) {
        const upd = {};
        if (patch.nickName !== undefined) upd.nickName = patch.nickName;
        if (patch.avatarUrl !== undefined) upd.avatarUrl = patch.avatarUrl;
        if (Object.keys(upd).length) {
          await membersCol.where({ spaceId: event.spaceId, openid: OPENID }).update({ data: upd });
        }
      }
      return { success: true, profile: patch };
    }

    // 家庭背景图：空间级，全家人可见。
    // 没用小红花解锁时为「试用」——前端按 bgImageAt 判断 3 天是否到期，到期自动恢复默认。
    if (action === 'setBg') {
      const spaceId = event.spaceId;
      if (!spaceId) return { success: false, errMsg: '缺少空间' };
      if (!(await isMember(spaceId, OPENID))) return { success: false, errMsg: '无权访问该空间' };
      const patch = {};
      if (event.clear) {
        patch.bgImage = ''; patch.bgImageAt = 0; patch.bgImageBy = ''; patch.bgUntil = 0;
      } else {
        const url = String(event.bgImage || '').trim();
        if (!url) return { success: false, errMsg: '没有图片' };
        patch.bgImage = url;
        patch.bgImageAt = Date.now();
        patch.bgImageBy = (event.byName || '').slice(0, 24);
      }
      await spacesCol.doc(spaceId).update({ data: patch });
      return { success: true, ...patch };
    }

    // 开关：是否接收家庭通知（有人点菜时弹微信服务通知）
    if (action === 'setNotify') {
      await upsertUser(OPENID, { notifyOn: !!event.on });
      return { success: true, notifyOn: !!event.on };
    }

    if (action === 'setRole') {
      const me = await membersCol.where({ spaceId: event.spaceId, openid: OPENID }).get();
      if (!me.data.length || me.data[0].role !== 'owner') return { success: false, errMsg: '仅户主可操作' };
      if (event.targetOpenid === OPENID && event.role !== 'owner') {
        return { success: false, errMsg: '户主不能直接降级自己，请先转让' };
      }
      await membersCol.where({ spaceId: event.spaceId, openid: event.targetOpenid }).update({ data: { role: event.role } });
      if (event.role === 'owner') {
        await membersCol.where({ spaceId: event.spaceId, openid: OPENID }).update({ data: { role: 'admin' } });
      }
      return { success: true };
    }

    if (action === 'removeMember') {
      const me = await membersCol.where({ spaceId: event.spaceId, openid: OPENID }).get();
      if (!me.data.length || me.data[0].role !== 'owner') return { success: false, errMsg: '仅户主可移除成员' };
      if (event.targetOpenid === OPENID) return { success: false, errMsg: '不能移除自己' };
      const t = await membersCol.where({ spaceId: event.spaceId, openid: event.targetOpenid }).get();
      if (t.data.length && t.data[0].role === 'owner') return { success: false, errMsg: '不能直接移除户主' };
      await membersCol.where({ spaceId: event.spaceId, openid: event.targetOpenid }).remove();
      return { success: true };
    }

    // 重命名空间（仅户主 / 管理员可改）
    if (action === 'rename') {
      const spaceId = event.spaceId;
      const name = (event.name || '').trim();
      if (!spaceId) return { success: false, errMsg: '缺少空间' };
      if (!name) return { success: false, errMsg: '名称不能为空' };
      if (name.length > 20) return { success: false, errMsg: '名称太长（最多 20 字）' };
      const me = await membersCol.where({ spaceId, openid: OPENID }).get();
      if (!me.data.length) return { success: false, errMsg: '你不在该空间' };
      const role = me.data[0].role;
      if (role !== 'owner' && role !== 'admin') return { success: false, errMsg: '仅户主或管理员可改名' };
      await spacesCol.doc(spaceId).update({ data: { name } });
      return { success: true, name };
    }

    if (action === 'leave') {
      const me = await membersCol.where({ spaceId: event.spaceId, openid: OPENID }).get();
      if (!me.data.length) return { success: false, errMsg: '你不在该空间' };
      const mc = await membersCol.where({ spaceId: event.spaceId }).count();
      if (me.data[0].role === 'owner' && mc.total > 1) {
        return { success: false, errMsg: '请先把户主转让给他人再退出' };
      }
      await membersCol.where({ spaceId: event.spaceId, openid: OPENID }).remove();
      if (mc.total === 1) await spacesCol.doc(event.spaceId).remove();
      return { success: true };
    }

    // 删除我的全部数据（用户行使删除权：资料 + 成员关系 + 积分流水）
    if (action === 'deleteMyData') {
      const mine = await membersCol.where({ openid: OPENID }).get();
      const list = mine.data || [];
      const spaceIds = list.map(m => m.spaceId);
      const BUSINESS = ['orders', 'todos', 'festivals', 'reminders', 'finance', 'plans', 'dishes'];

      for (const sid of spaceIds) {
        const cnt = await membersCol.where({ spaceId: sid }).count();
        await membersCol.where({ spaceId: sid, openid: OPENID }).remove();
        // 我是这个空间最后一个人 → 连空间和业务数据一起清掉
        if (cnt.total <= 1) {
          for (const c of BUSINESS) {
            await db.collection(c).where({ spaceId: sid }).remove().catch(() => {});
          }
          await spacesCol.doc(sid).remove().catch(() => {});
        }
      }

      // 全局资料
      await usersCol.doc(OPENID).remove().catch(() => {});

      // 小红花流水：我名下的 + 我所在空间名下的
      const logsCol = db.collection('flowerLogs');
      await logsCol.where({ openid: OPENID }).remove().catch(() => {});
      if (spaceIds.length) {
        await logsCol.where({ spaceId: _.in(spaceIds) }).remove().catch(() => {});
      }

      return { success: true, spaces: spaceIds.length };
    }

    // 延长会员使用期限（虚拟支付发货 / 兑换码 共用）
    // months 按月（每月按 30 天计），days 按天；从当前剩余时间往后叠加，不会缩短。
    if (action === 'extendMember') {
      const months = Math.max(0, Math.round(Number(event.months) || 0));
      const days = Math.max(0, Math.round(Number(event.days) || 0));
      if (months === 0 && days === 0) return { success: false, errMsg: '没有要延长的时长' };
      const u = await getUser(OPENID);
      const base = (u && u.memberUntil && u.memberUntil > Date.now()) ? u.memberUntil : Date.now();
      const until = base + months * 30 * 86400000 + days * 86400000;
      await upsertUser(OPENID, { memberUntil: until });
      return { success: true, memberUntil: until };
    }

    return { success: false, errMsg: '未知操作' };
  } catch (e) {
    // 把错误码一起带回前端：云开发里"集合不存在"是 -502005，
    // 前端靠它区分"该建表了"还是"云函数压根没部署"。
    return {
      success: false,
      errCode: (e && e.errCode) || 0,
      errMsg: (e && (e.errMsg || e.message)) || String(e)
    };
  }
};
