// 多 Worker 槽位与所属私有通信的浏览器 fixture 契约（PSM-R11–R13）。
//
// 这里定义产品无关的内存契约：
//   - VaultBalance：假 Vault 后台服务，部署到独立 Worker 槽位；
//   - VaultListAll：Vault 的**私有**函数，只对同插件同单元的 Web 单元可见；
//   - StorageFiles：假 Storage 后台的公开服务，与私有函数分开。
//
// 私有能力不在任何普通 provides 里；WebLoom 只为所属运行单元签发解析入口。

import { defineCapability } from "../../src/index.ts";

const parseRequest = { parse(value: unknown): { text: string } {
  if (!value || typeof value !== "object") throw new Error("invalid request");
  const text = (value as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("invalid request text");
  return value as { text: string };
} };

const parseCount = { parse(value: unknown): { text: string } { return parseRequest.parse(value); } };

const parseBalance = { parse(value: unknown): { balance: string } {
  if (!value || typeof value !== "object") throw new Error("invalid balance");
  const balance = (value as { balance?: unknown }).balance;
  if (typeof balance !== "string") throw new Error("invalid balance value");
  return value as { balance: string };
} };

const parseFiles = { parse(value: unknown): { files: string } {
  if (!value || typeof value !== "object") throw new Error("invalid files");
  const files = (value as { files?: unknown }).files;
  if (typeof files !== "string") throw new Error("invalid files value");
  return value as { files: string };
} };

/** 假 Storage 的公开后台服务（对内公开）。 */
export const StorageFiles = defineCapability<{ text: string }, { files: string }>({
  kind: "rpc",
  id: "fixture.psm.storage.files",
  version: "1",
  request: parseRequest,
  response: parseFiles,
});

/** 假 Storage 的私有后台函数：只对同插件同单元开放。 */
export const StorageListAll = defineCapability<{ text: string }, { files: string }>({
  kind: "rpc",
  id: "fixture.psm.storage.listAll",
  version: "1",
  request: parseCount,
  response: parseFiles,
});

/** 假 Vault 的公开后台服务，部署到另一个 Worker。 */
export const VaultBalance = defineCapability<{ text: string }, { balance: string }>({
  kind: "rpc",
  id: "fixture.psm.vault.balance",
  version: "1",
  request: parseRequest,
  response: parseBalance,
});

/** 假 Vault 的私有后台函数：同样只对所属单元可见。 */
export const VaultListAll = defineCapability<{ text: string }, { balance: string }>({
  kind: "rpc",
  id: "fixture.psm.vault.listAll",
  version: "1",
  request: parseCount,
  response: parseBalance,
});
