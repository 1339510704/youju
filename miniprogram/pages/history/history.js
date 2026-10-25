const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ensureSpace } = require('../../utils/guard.js');

// 历史订单：做完的菜自动从点菜清单移到这里，按完成时间倒序
Page({
  data: {
    space: null, list: []
  },

  onShow() { this.prepare(); bg.apply(this); },

  async prepare() {
    const space = await ensureSpace();
    if (!space) return;
    this.setData({ space });
    if (space.type !== 'family') return;
    this.load();
  },

  async load() {
    const r = await call('content', { action: 'list', coll: 'orders', spaceId: this.data.space._id })
      .catch(() => ({ list: [] }));
    const list = (r.list || [])
      .filter(x => x.status === 'done')
      .map(x => Object.assign({}, x, { doneText: fmtTime(x.doneAt || x.createdAt) }))
      .sort((a, b) => {
        const ta = new Date(a.doneAt || a.createdAt || 0).getTime();
        const tb = new Date(b.doneAt || b.createdAt || 0).getTime();
        return tb - ta;
      });
    this.setData({ list });
  }
});

function pad(n) { return n < 10 ? ('0' + n) : ('' + n); }

function fmtTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
