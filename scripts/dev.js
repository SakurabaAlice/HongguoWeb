// 开发模式：同时启动后端（自动重启）与 Vite 前端开发服务器
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const children = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [require.resolve('vite/bin/vite.js', { paths: [root] })], { cwd: root, stdio: 'inherit' }),
];

const stop = () => { for (const child of children) child.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code) stop(); });
