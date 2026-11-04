// 站点挂载路径。部署在子路径（如 /hongguo/）时由构建参数 BASE_PATH 决定，本地开发为根路径。
// BASE 不带结尾斜杠：'' 或 '/hongguo'
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

// 页面上「源码」链接的地址。本项目以 AGPL-3.0 发布：部署修改过的版本供他人使用时，
// 需要通过构建参数 VITE_SOURCE_URL 指向你自己的源码。
export const SOURCE_URL = import.meta.env.VITE_SOURCE_URL || 'https://github.com/SakurabaAlice/HongguoWeb';
