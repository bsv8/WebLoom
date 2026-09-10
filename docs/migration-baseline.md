# WebLoom 拆分基线

本次独立拆分的源码基线记录如下：

| 项目 | 值 |
| --- | --- |
| 来源仓库基线 | `f937804fe47c53b3e452ba6cbad4d1687c7671c4` |
| WebLoom 起始提交 | `f1c801655c3132c57b66045ff6d5e642fba4a8ea` |
| Node | `v22.13.1` |
| pnpm | `11.5.1` |
| 下一发布包版本 | `0.3.0` |
| npm 包名 | `webloom-framework` |
| 发布来源提交 | `a5ace48` |
| 已发布基线标签 | `v0.1.0` |

迁入范围是通用 Manifest、依赖图、Host 调度、MessageBus、生命周期 Scope、权限租约、服务桥、MessagePort 传输、升级门禁、意图控制、任务调度、资源 Store 和 React 绑定。产品 Registry、业务配置、产品日志、身份状态机和视觉组件不属于 WebLoom。

本文件记录代码迁移基线和首发包发布 provenance。npm 包名占用查询、许可证归属确认、
发布和部署由发布责任人在发布批次执行；施工代理不自动发布。

## 当前工作区发布状态

当前工作区正在准备 `webloom-framework@0.3.0`，但该版本尚未发布到 npm；下游在发布
责任人完成正式发布前继续使用本地工作区依赖。`v0.1.0` / npm `0.1.0` 是已发布基线，
不是本轮未发布代码的验收替代品。

WebLoom 已形成包含全部实现和测试的正式发布提交 `a5ace48`，并以 `v0.1.0` 标签发布
`webloom-framework@0.1.0`。上表的 `WebLoom 起始提交` 仍只是独立仓库初始化提交，
不作为 `0.1.0` 的源码 provenance。

发布记录确认如下：

- `AGPL-3.0-only` 源码归属和发布责任已按包元数据记录；
- `pnpm run pack:consumer` 已验证 tarball 的 core-only、React 和 Worker 三类消费者；
- 每个临时消费者均使用独立的 `smoke.ts` 和临时项目自己的 `tsc --noEmit`
  编译公开声明；Worker 消费者使用 `lib: ["ES2022", "WebWorker"]` 且不安装 React；
- `npm pack --json` 已通过发布文件白名单、tarball/解包体积上限和必需入口文件检查；
- 从 tarball 解包后扫描全部 `.d.ts` 与 `.js.map`，未发现本地绝对路径、不可发布的
  source map 路径以及产品领域字段；
- 已创建 `v0.1.0` tag 并发布 npm 包 `webloom-framework@0.1.0`。
