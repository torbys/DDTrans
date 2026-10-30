function connectionError({ status, code, message, requestId } = {}) {
  const errors = {
    401: ['authentication_failed', 'API Key 验证失败（HTTP 401）。请核对 Key，并使用同一业务空间的接入地址。'],
    403: ['access_denied', '没有模型访问权限（HTTP 403）。请检查业务空间、地域和模型授权。'],
    404: ['endpoint_not_found', '实时接口不存在（HTTP 404）。请填写业务空间的接入地址。'],
    429: ['rate_limited', '模型调用已限流或额度不足（HTTP 429）。请检查百炼控制台后重试。'],
  };
  const known = errors[status];
  const error = new Error(known?.[1] || message || (status ? '模型服务暂时不可用（HTTP ' + status + '）' : '模型网络连接已中断'));
  error.code = known?.[0] || code || (status ? 'service_unavailable' : 'network_error');
  error.retryable = !known && (status >= 500 || ['network_error', 'connection_timeout'].includes(error.code));
  if (status) error.httpStatus = status;
  if (requestId) error.requestId = String(requestId).slice(0, 200);
  return error;
}
module.exports = { connectionError };
