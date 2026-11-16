// 可由浏览器或 Node 宿主提供传输。正式产品应复用自己的 APIProtocol。
import { createWindowApp, defineCapability, defineDaemonBridge, definePlugin, type DaemonTransport } from "../../src/index.js";

const text = { parse(value: unknown) { if (typeof value !== "string") throw new TypeError("笔记必须是字符串"); return value; } };
const empty = { parse(value: unknown) { if (value !== null) throw new TypeError("读取不接受参数"); return null; } };
const saved = { parse(value: unknown) { if (value !== true) throw new TypeError("保存未成功"); return true as const; } };
export const ReadNote = defineCapability({ kind: "rpc", id: "notes.read", version: "1", request: empty, response: text });
export const SaveNote = defineCapability({ kind: "rpc", id: "notes.save", version: "1", request: text, response: saved });

/** 每次页面挂载创建一个前台实例。停止只释放本页面，不关闭后台。 */
export async function startNotes(transport: DaemonTransport, view: {
  show(content: string): void;
  onSave(save: (content: string) => Promise<void>): () => void;
}) {
  return createWindowApp({ id: "notes-web", plugins: [
    defineDaemonBridge({ id: "notes-api", transport, bindings: [
      { capability: ReadNote, method: "notes.read" },
      { capability: SaveNote, method: "notes.save" },
    ] }),
    definePlugin({ id: "notes", unitId: "notes.web", dependencies: [{ capability: ReadNote }, { capability: SaveNote }],
      setup(ctx) {
        const read = ctx.capability(ReadNote);
        const save = ctx.capability(SaveNote);
        const remove = view.onSave(async content => { await save.call(content); });
        ctx.onDispose(remove);
        // 不阻塞整个前台启动；页面关闭后不再展示迟到结果。
        void read.call(null).then(content => { if (!ctx.signal.aborted) view.show(content); }).catch(error => {
          if (!ctx.signal.aborted) view.show(`读取失败：${String(error)}`);
        });
      },
    }),
  ] });
}
