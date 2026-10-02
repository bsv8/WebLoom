// 真实浏览器 fixture 的 Vite 构建配置。
//
// Vite 默认只把根目录的 index.html 当作构建入口；本 fixture 需要同时产出两个
// 页面：SharedWorker 运行时验收页与插件实例消费边界验收页。漏掉第二个入口时
// 生产产物里没有该 HTML，浏览器拿到 404，而不是"测试通过"。
//
// 共享组件与 React 都来自本仓库 devDependencies，构建产物仍然是真实生产产物：
// Worker 由 Vite 产出独立 chunk，页面不内联源码。

import { fileURLToPath } from "node:url";

const fixtureFile = (name) => fileURLToPath(new URL(name, import.meta.url));

export default {
  build: {
    rollupOptions: {
      input: {
        // SharedWorker 运行时场景页（index.html）。
        index: fixtureFile("./index.html"),
        // 插件实例消费边界场景页（plugin-consumer.html）。
        "plugin-consumer": fixtureFile("./plugin-consumer.html"),
        // 多 Worker 槽位与所属私有通信场景页（multi-worker.html）。
        "multi-worker": fixtureFile("./multi-worker.html"),
      },
    },
  },
};
