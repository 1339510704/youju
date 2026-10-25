// 轻量日期工具（纯前端，无依赖）
function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmt(d) {
  d = d ? new Date(d) : new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function fmtTime(d) {
  d = d ? new Date(d) : new Date();
  return fmt(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 返回今天日期字符串 YYYY-MM-DD
function today() { return fmt(new Date()); }

// 距离今天还有多少天（dateStr 为 YYYY-MM-DD 或 Date）
function daysUntil(dateStr) {
  const t = new Date(fmt(new Date())).getTime();
  const target = new Date(fmt(new Date(dateStr))).getTime();
  return Math.round((target - t) / 86400000);
}

// 取下一个即将到来的节日 {name, days}
// 公历日期若已经过去，要顺延到明年再算 —— 否则「填了几个月前的日子」会被当成过期而整个漏掉
function nextFestival(list) {
  if (!list || !list.length) return null;
  const arr = list
    .map(f => {
      let days = daysUntil(f.date);
      if (!isNaN(days) && days < 0) {
        const t = new Date(f.date + 'T00:00:00');
        if (!isNaN(t.getTime())) {
          t.setFullYear(t.getFullYear() + 1);
          days = daysUntil(fmt(t));
        }
      }
      return { f, days };
    })
    .filter(x => !isNaN(x.days) && x.days >= 0)
    .sort((a, b) => a.days - b.days);
  return arr.length ? { name: arr[0].f.name, days: arr[0].days } : null;
}

// 把截止日期转成口语化描述，例：今天到期 / 明天到期 / 已逾期 3 天 / 10月5日
function friendlyDue(dateStr) {
  if (!dateStr) return '';
  const d = daysUntil(dateStr);
  if (d < 0) return '已逾期 ' + Math.abs(d) + ' 天';
  if (d === 0) return '今天到期';
  if (d === 1) return '明天到期';
  if (d === 2) return '后天到期';
  if (d <= 7) return d + ' 天后到期';
  const t = new Date(dateStr);
  if (isNaN(t.getTime())) return String(dateStr);
  return (t.getMonth() + 1) + '月' + t.getDate() + '日';
}

// 创建时间：同年省略年份，显示到「几点几分」。列表里补这个字段就能显示"什么时候建的"
function fmtCreated(v) {
  if (!v) return '';
  const t = new Date(v);
  if (isNaN(t.getTime())) return '';
  const now = new Date();
  const md = (t.getMonth() + 1) + '月' + t.getDate() + '日';
  const hm = pad(t.getHours()) + ':' + pad(t.getMinutes());
  return (t.getFullYear() === now.getFullYear() ? md : (t.getFullYear() + '年' + md)) + ' ' + hm;
}

module.exports = { pad, fmt, fmtTime, today, daysUntil, nextFestival, friendlyDue, fmtCreated };
