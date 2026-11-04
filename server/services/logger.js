// SPDX-License-Identifier: AGPL-3.0-only
// 简易控制台日志，接口与上游 logger 保持一致（info / warn / error）。
// 通过环境变量 LOG_LEVEL=debug|info|warn|error 控制输出级别。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatExtra(extra) {
  if (extra === undefined) return '';
  if (extra instanceof Error) return `\n${extra.stack || extra.message}`;
  if (typeof extra === 'object') {
    try { return ' ' + JSON.stringify(extra); } catch (_) { return ' [Object]'; }
  }
  return ' ' + String(extra);
}

function write(level, tag, message, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${timestamp()} ${level.toUpperCase().padEnd(5)} ${tag ? `[${tag}] ` : ''}${message}${formatExtra(extra)}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

module.exports = {
  debug: (tag, message, extra) => write('debug', tag, message, extra),
  info: (tag, message, extra) => write('info', tag, message, extra),
  warn: (tag, message, extra) => write('warn', tag, message, extra),
  error: (tag, message, extra) => write('error', tag, message, extra),
};
