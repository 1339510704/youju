// 统一的云函数调用封装：成功返回 result，失败 reject（含错误信息）
function call(name, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({ name, data })
      .then(res => {
        const r = res.result || {};
        if (r.success) resolve(r);
        else reject(r.errMsg || '操作失败');
      })
      .catch(err => reject((err && err.errMsg) || '网络错误'));
  });
}

// 读取 app 全局对象（空间等）
function app() { return getApp(); }

// 选图（返回本地临时路径数组）
function pickImage(count) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: count || 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: res => resolve((res.tempFiles || []).map(f => f.tempFilePath)),
      fail: reject
    });
  });
}

// 上传图片到云存储，返回 fileID（按 openid 分目录，便于隔离与管理）
function uploadImage(filePath, dir) {
  const openid = (getApp().globalData.openid) || 'anon';
  const raw = filePath.split('?')[0];
  let ext = raw.split('.').pop() || 'png';
  if (ext.length > 5) ext = 'png';
  const cloudPath = (dir || 'uploads') + '/' + openid + '/' + Date.now() + '_' +
    Math.floor(Math.random() * 1000) + '.' + ext;
  return wx.cloud.uploadFile({ cloudPath, filePath }).then(r => r.fileID);
}

// 云存储文件 ID（cloud://...）→ 可直接用的 https 链接。
//
// ⚠️ 关键：这里走【云函数】换取，不再用小程序端 wx.cloud.getTempFileURL。
//    因为云存储权限默认是「仅创建者可读写」，小程序端换"别人上传的图"的链接会失败
//    —— 表现就是家人看不到菜品图 / 家庭背景图。而云函数（服务端）拥有全部文件的读写权限，
//    由它换取再回传，任何用户都能正常显示。（控制台原话：以下配置仅对小程序端发起的请求有效）
// ⚠️ 临时链接有有效期（最长 2 小时），所以带 TTL 缓存，过期自动重换；
//    换取失败时沿用上一次换到的链接，避免图片/背景毫无预兆地消失。
const _urlCache = {};   // fileID -> { url, ts }
const URL_TTL = 45 * 60 * 1000;
const BATCH = 50;       // 单次获取上限

// 批量换取：传入 fileID 数组，返回 { fileID: httpsUrl }
// 列表页（菜单/饭桌）用它一次性把一屏图片全部换好，只花一次云调用。
async function fileUrls(ids) {
  const list = [];
  (ids || []).forEach(x => {
    if (typeof x === 'string' && x.indexOf('cloud://') === 0 && list.indexOf(x) < 0) list.push(x);
  });
  const out = {};
  const now = Date.now();
  const need = [];
  list.forEach(id => {
    const hit = _urlCache[id];
    if (hit && now - hit.ts < URL_TTL) out[id] = hit.url;
    else if (need.indexOf(id) < 0) need.push(id);
  });
  if (!need.length) return out;
  try {
    const r = await call('content', { action: 'fileUrls', ids: need.slice(0, BATCH) });
    const urls = (r && r.urls) || {};
    Object.keys(urls).forEach(id => {
      if (!urls[id]) return;
      _urlCache[id] = { url: urls[id], ts: Date.now() };
      out[id] = urls[id];
    });
  } catch (e) { /* 换不到走下面兜底 */ }

  // 服务端没换到（比如 content 云函数还没更新到带 fileUrls 的版本）：
  // 退回小程序端自己换一次 —— 对自己上传的图（多数是背景图）这条是能成功的。
  const still = need.filter(id => !out[id]);
  if (still.length && wx.cloud && wx.cloud.getTempFileURL) {
    try {
      const cf = await wx.cloud.getTempFileURL({ fileList: still.slice(0, BATCH) });
      ((cf && cf.fileList) || []).forEach(f => {
        if (f && f.fileID && f.tempFileURL) {
          _urlCache[f.fileID] = { url: f.tempFileURL, ts: Date.now() };
          out[f.fileID] = f.tempFileURL;
        }
      });
    } catch (e) { /* 客户端也换不到就算了 */ }
  }
  // 还是没换到的：之前换过（只是过期了）就先用旧的顶上
  need.forEach(id => { if (!out[id] && _urlCache[id] && _urlCache[id].url) out[id] = _urlCache[id].url; });
  return out;
}

async function fileUrl(fileID) {
  if (!fileID) return '';
  if (String(fileID).indexOf('cloud://') !== 0) return fileID;
  const m = await fileUrls([fileID]);
  return m[fileID] || '';
}
// 清掉所有链接缓存（切换空间 / 资料变化时调用，避免命中旧链接）
function invalidateUrlCache() { for (const k in _urlCache) delete _urlCache[k]; }

module.exports = { call, app, pickImage, uploadImage, fileUrl, fileUrls, invalidateUrlCache };
