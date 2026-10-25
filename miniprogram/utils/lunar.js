// 农历转换（1900-2100），纯前端无依赖
// 数据表 lunarInfo 为公开经典编码，每项 20bit：低 4bit = 闰月月份（0=无），
// 第 16bit = 闰月天数(1=30天)，其余 12bit 从高位到低位代表正月~腊月的天数(1=30天)。
const lunarInfo = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af2, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520 // 2100
];

function lYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
  return sum + leapDays(y);
}
function leapMonth(y) { return lunarInfo[y - 1900] & 0xf; }
function leapDays(y) {
  if (leapMonth(y)) return (lunarInfo[y - 1900] & 0x10000) ? 30 : 29;
  return 0;
}
function monthDays(y, m) { return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29; }

// 农历(y, m, d, isLeap) → 公历 {y, m, d}
function lunarToSolar(y, m, d, isLeap) {
  // 该农历月实际天数（闰月用闰月天数）；选了「三十」但该月只有廿九时，按上限收住，避免错位
  const monthMax = (isLeap && leapMonth(y) === m) ? leapDays(y) : monthDays(y, m);
  d = Math.min(Math.max(1, d), monthMax);
  let offset = 0;
  for (let i = 1900; i < y; i++) offset += lYearDays(i);
  const leap = leapMonth(y);
  for (let i = 1; i < m; i++) offset += monthDays(y, i);
  if (leap > 0 && m === leap) offset += monthDays(y, leap);          // 正常 leap 月在目标之前
  if (leap > 0 && m > leap) offset += leapDays(y);                  // 闰月在目标月之前
  if (leap > 0 && m === leap && isLeap) offset += leapDays(y);      // 目标闰月：闰月天数也在前面
  offset += d - 1;
  const base = Date.UTC(1900, 0, 31);
  const dt = new Date(base + offset * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// 公历(y, m, d) → 农历 {lunarYear, lunarMonth, lunarDay, isLeap}
function solarToLunar(y, m, d) {
  const base = Date.UTC(1900, 0, 31);
  const obj = Date.UTC(y, m - 1, d);
  let offset = Math.round((obj - base) / 86400000);
  let i, temp = 0;
  for (i = 1900; i < 2101 && offset > 0; i++) { temp = lYearDays(i); offset -= temp; }
  if (offset < 0) { offset += temp; i--; }
  const lunarYear = i;
  const leap = leapMonth(i);
  let isLeap = false, lunarMonth = 1, lunarDay = 1;
  let mth = 1;
  while (mth <= 12) {
    temp = monthDays(i, mth);
    if (offset < temp) { lunarMonth = mth; lunarDay = offset + 1; break; }
    offset -= temp;
    if (leap > 0 && mth === leap) {            // 正常 leap 月之后紧跟闰月
      temp = leapDays(i);
      if (offset < temp) { isLeap = true; lunarMonth = mth; lunarDay = offset + 1; break; }
      offset -= temp;
    }
    mth++;
  }
  return { lunarYear, lunarMonth, lunarDay, isLeap };
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

// 农历月日 → 「下一个」公历日期（从今年起，跨年补到明年），返回 {y, m, d, dateStr}
// 闰月节日：近一两年可能没有该闰月，放宽到未来 10 年找最近一个有该闰月的年份
function lunarNextSolar(m, d, isLeap) {
  const now = new Date();
  const curY = now.getFullYear();
  const today0 = new Date(curY, now.getMonth(), now.getDate());
  let last = null;
  for (let y = curY; y <= curY + 10; y++) {
    if (isLeap && leapMonth(y) !== m) continue; // 该年没有这个闰月
    const s = lunarToSolar(y, m, d, isLeap);
    const t = new Date(s.y, s.m - 1, s.d);
    if (t >= today0) return { y: s.y, m: s.m, d: s.d, dateStr: fmtDate(s.y, s.m, s.d) };
    last = { y: s.y, m: s.m, d: s.d, dateStr: fmtDate(s.y, s.m, s.d) };
  }
  if (last) return last;
  const s = lunarToSolar(curY + 1, m, d, false);
  return { y: s.y, m: s.m, d: s.d, dateStr: fmtDate(s.y, s.m, s.d) };
}

const MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '腊月'];
const DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
function cnMonth(m, isLeap) { return (isLeap ? '闰' : '') + (MONTHS[(m - 1 + 12) % 12] || ''); }
function cnDay(d) { return DAYS[Math.max(1, Math.min(30, d)) - 1]; }
function lunarText(m, d, isLeap) { return cnMonth(m, isLeap) + cnDay(d); }

module.exports = { lunarToSolar, solarToLunar, lunarNextSolar, lunarText, leapMonth, cnMonth, cnDay, MONTHS, DAYS };
