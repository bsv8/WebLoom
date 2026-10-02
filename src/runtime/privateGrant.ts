// 私有入口的授权记录与连接绑定票据（PSM-R13）。
//
// 授权由两部分组成：
//
//   1. **装配层机密**（静态配置）：`definePrivateCapability({ grantId })` 交给 Host 选项
//      `privateCapabilities`，按调用单元 `pluginId + unitId` 登记。机密不进入服务目录。
//   2. **实例授权记录**（每次实例启动签发）：`{ secret, instanceId }`，撤销时删除，重建时
//      依据配置重新签发新的 instanceId。
//
// 票据把两者和物理连接绑在一起：
//
//   token = derivePrivateGrant(secret, connectionId, instanceId)
//
// 接收端用「自己掌握的机密 × 对端快照中仍然活着的实例」逐一比对，因此：
//   - 未授权单元拿不到机密，推导不出票据；
//   - 实例被撤销后它从对端快照消失，旧票据立即失效；
//   - 实例重建后 instanceId 变化，必须重新解析才能拿到新票据；
//   - 换连接、重连或别的连接重放旧票据都会失败（connectionId 不同）。
//
// 说明：transport 与两端 Host 都是框架可信组件，这里防的是"同一 realm 内未授权的插件
// 实例拿到私有入口"，不是密码学意义上的通道安全。

/** 64 位 FNV-1a（两条不同偏移的 lane 拼成 128 位十六进制）。 */
function fnv1a64(input: string, offset: string): string {
  let hash = BigInt(`0x${offset}`);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * 推导实例与连接绑定的私有票据。
 *
 * 票据由两个独立分量组成：`连接分量` 与 `实例分量`。接收端按自己掌握的信息分别核对：
 * 对端发布单元快照时两个分量都要匹配；没有发布时只能核对连接分量（此时实例撤销由调用
 * 侧拦截，重放边界是这条连接）。
 *
 * @param secret 装配层机密。
 * @param connectionId 物理连接标识：调用方用自己的，接收方用入站调用的。
 * @param instanceId 调用实例身份：撤销后失效，重建后变化。
 */
export function derivePrivateGrant(secret: string, connectionId: string, instanceId: string): string {
  if (typeof secret !== "string" || secret === "") throw new TypeError("Private grant requires a non-empty secret");
  if (typeof connectionId !== "string" || connectionId === "") throw new TypeError("Private grant requires a non-empty connection id");
  if (typeof instanceId !== "string" || instanceId === "") throw new TypeError("Private grant requires a non-empty instance id");
  const connection = fnv1a64(`${secret} ${connectionId}`, "cbf29ce484222325") + fnv1a64(`${connectionId} ${secret}`, "9ae16a3b2f90404f");
  const instance = fnv1a64(`${secret} ${instanceId}`, "84222325cbf29ce4") + fnv1a64(`${instanceId} ${secret}`, "f90404f9ae16a3b");
  return `pg3.${connection}.${instance}`;
}

/** 票据中的连接分量（`pg3.<连接分量>.<实例分量>`）。 */
function connectionPart(token: string): string | undefined {
  const parts = token.split(".");
  return parts.length === 3 && parts[0] === "pg3" ? parts[1] : undefined;
}

/** 常数时间比较，避免票据比较被计时侧信道利用。 */
export function privateGrantMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return difference === 0;
}

/** 一条可信的私有授权记录：机密与消费实例一一对应。 */
export interface PrivateGrantCandidate {
  /** 被授权的调用单元所属插件。 */
  readonly pluginId: string;
  /** 被授权的调用单元。 */
  readonly unitId: string;
  /** 装配层机密（与该单元一一对应）。 */
  readonly secret: string;
  /** 该单元当前存活的实例身份。 */
  readonly instanceId: string;
}

/** 接收端用于核对的授权记录。 */
export interface PrivateGrantCheck {
  /** 该服务是否按私有方式登记。 */
  readonly private: boolean;
  /** 机密与实例一一对应的候选记录；为空表示没有任何可授权实例。 */
  readonly candidates: readonly PrivateGrantCandidate[];
  /** 入站调用携带的票据。 */
  readonly grantId: string | undefined;
  /** 入站调用的物理连接标识。 */
  readonly connectionId: string | undefined;
}

/**
 * 接收端的私有授权检查（PSM-R13）。
 *
 * RPC 与 stream 共用：都必须在执行 handler 之前完成。通过时返回命中的实例身份（诊断用），
 * 失败返回 undefined。
 */
export function authorizedPrivateInstance(input: PrivateGrantCheck): string | undefined {
  if (!input.private) return "";
  if (input.candidates.length === 0 || input.connectionId === undefined) return undefined;
  for (const candidate of input.candidates) {
    const expected = derivePrivateGrant(candidate.secret, input.connectionId, candidate.instanceId);
    if (privateGrantMatches(expected, input.grantId)) return candidate.instanceId;
  }
  return undefined;
}

/** 布尔形态：私有服务必须命中某条授权记录。 */
export function privateCallAuthorized(input: PrivateGrantCheck): boolean {
  return authorizedPrivateInstance(input) !== undefined;
}
