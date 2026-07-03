// 调试:重放 Gate D 的三轮 onboard,打印每轮抽取 JSON 与 readiness。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../src/store/book.js";
import { initRepo, commitAll } from "../src/store/git.js";
import { loadConfigFrom } from "../src/config.js";
import { modelFor } from "../src/llm/provider.js";
import { streamCall, generateCall } from "../src/llm/call.js";
import { onboardTurn } from "../src/engine/onboard.js";

const root = path.resolve(import.meta.dirname, "..");
for (const line of fs.readFileSync(path.join(root, "secrets.env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
  if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
}
const loaded = loadConfigFrom(root);

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2dbg-")), "测试书");
const store = BookStore.create(dir, { name: "测试书" });
initRepo(dir);
commitAll(dir, "init");

const deps = {
  chatter: (input: { messages: never; onUsage?: never }) =>
    streamCall({ model: modelFor(loaded, "writer"), messages: input.messages, onUsage: input.onUsage }),
  extractor: (input: { messages: never; onUsage?: never }) =>
    generateCall({ model: modelFor(loaded, "extractor"), messages: input.messages, onUsage: input.onUsage }),
  embedder: null,
  config: loaded.config,
} as never;

const rounds = [
  "都市异能复仇文,主角陈默,一个在旧书店打工的青年,父亲三年前死于一场被定性为意外的火灾",
  "第一人称,目标50章;世界观:灵气复苏后的现代都市,异能者由『异管局』暗中管理,普通人不知情",
  "第一卷就写陈默觉醒『过目不忘』异能、进入异管局外围、查出父亲死因不是意外,就这样,开始吧",
];

for (const [i, message] of rounds.entries()) {
  console.log(`\n===== 第 ${i + 1} 轮:${message.slice(0, 30)}…`);
  const result = await onboardTurn(store, message, deps);
  console.log(`--- 回复(前200字):${result.reply.slice(0, 200)}`);
  console.log(`--- 抽取:${JSON.stringify(result.extracted, null, 1).slice(0, 1200)}`);
  console.log(`--- readiness:ready=${result.readiness.ready} 缺:${result.readiness.missing.join("、")}`);
}
console.log(`\n大纲.md 内容:\n${store.readDoc("大纲")}`);
