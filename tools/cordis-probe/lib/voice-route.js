/**
 * 语音开关路由：`GET` 读当前状态、`POST` 翻转。
 *
 * 存在的理由：注册语音的代码在宿主（Node），而按钮在页面——两半没有直接通道，
 * 所以由宿主开一个最小路由让页面点。只服务本示例，不进 dsh-pet 的接口面。
 * @module dsh-cordis-probe/voice-route
 */

/** 路由前缀（与 dsh-pet 的 `/dsh-pet-7340` 并列，互不干扰）。 */
export const VOICE_ROUTE = '/cordis-probe-voice';

/**
 * 处理一次开关请求。
 * @param req - Node 请求对象。
 * @param res - Node 响应对象。
 * @param control - 读写开关的两个函数；`setOn` 返回生效后的状态。
 */
export function handleVoiceRoute(req, res, control) {
  if (req.method === 'GET') {
    respond(res, 200, { ok: true, on: control.isOn() });
    return;
  }
  if (req.method !== 'POST') {
    respond(res, 405, { ok: false, reason: 'method-not-allowed' });
    return;
  }
  // 不带请求体：点一次就是翻转一次，省掉解析与校验
  respond(res, 200, { ok: true, on: control.setOn(!control.isOn()) });
}

/** 写一个 JSON 响应。 */
function respond(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
