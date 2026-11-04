// 站点挂载路径。部署在子路径（如 /hongguo/）时由构建参数 BASE_PATH 决定，本地开发为根路径。
// BASE 不带结尾斜杠：'' 或 '/hongguo'
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
