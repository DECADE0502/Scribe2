/**
 * 正文消毒器(SPEC §4.1):把模型输出里的格式噪音剥干净,只留正文。
 * 对"正常正文"必须是恒等函数——宁可漏删,不可误伤。
 * 章末"本章完/待续"之类尾标记不在这里处理,归 lint 管(可配置放行)。
 */

/** 首部元话语:寒暄引导行("好的,以下是第5章正文:")或重复的章节台头。 */
function isMetaLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  // markdown 章节台头:# 第五章 / ### 第5章 风起
  if (/^#{1,6}\s*第\s*[0-9一二三四五六七八九十百千零两]+\s*章/.test(t)) return true;
  // 寒暄 + 冒号结尾的引导行:好的,以下是第5章正文: / 以下是本章内容:
  if (/^(好的|好嘞|好|当然|明白|收到|没问题)[,,!!]?.{0,30}[::!!]?$/.test(t) && t.length <= 40) {
    // 只删确实像"元话语"的:含承接词或提及正文/章节,不含叙事标点
    if (/(以下|下面|这是|正文|章节|内容|没问题)/.test(t) || /^(好的|好嘞|当然|明白|收到)[,,!!]?$/.test(t)) {
      return true;
    }
  }
  if (/^以下是.{0,30}[::]\s*$/.test(t)) return true;
  return false;
}

export function sanitizeProse(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");

  // 1) 显式定界符优先:取【正文开始】…【正文结束】内部
  const begin = text.indexOf("【正文开始】");
  const end = text.indexOf("【正文结束】");
  if (begin !== -1 && end !== -1 && end > begin) {
    text = text.slice(begin + "【正文开始】".length, end);
  }

  // 2) 全文围栏:首行 ```xxx 且末行 ``` → 剥掉两端
  const lines = text.trim().split("\n");
  if (lines.length >= 2 && /^```[\w-]*$/.test(lines[0]!.trim()) && lines[lines.length - 1]!.trim() === "```") {
    text = lines.slice(1, -1).join("\n");
  }

  // 3) 从头连续删元话语行(只处理首部,正文中间一律不动)
  const rest = text.trim().split("\n");
  while (rest.length > 0 && (rest[0]!.trim() === "" || isMetaLine(rest[0]!))) {
    rest.shift();
  }
  return rest.join("\n").trim();
}
