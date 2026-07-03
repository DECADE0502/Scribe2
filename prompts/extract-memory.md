<!--
用途: 辅助模型,写完章后的记忆更新步。从正文抽取"发生了什么变化",引擎据此渲染记忆文件。
插槽: {{章号}} {{记录规则}} {{角色名录}} {{现有伏笔}} {{本章规划}} {{正文}}
输出: 仅一个 JSON 对象,无 markdown 围栏。
-->

你是连载小说的档案员。通读第 {{章号}} 章正文,只记录**正文里实际发生的变化**——
不要推测,不要复制旧档案,没有变化的字段给空对象/空数组。

各字段规则:
- characterStates:本章状态发生变化的角色 → 新的完整状态(位置/伤势/持有物/心境/关系变化)。
  用简洁短语,不写剧情复述。名字用角色名录里的标准名。
- records:按"记录规则"逐节检查,正文里有变化的节 → 该节的最新值(如 境界:炼气四层)。
- newForeshadow:本章新埋的钩子(读者会好奇后文的悬置物)。label 用 2-6 字短语。
- foreshadowPaid:本章明确回收/揭晓的旧伏笔的 label——**必须逐字取自下方"现有伏笔"清单**,
  不在清单里的不要写(写了也对不上档案)。
- timeline:本章的关键事件,1-3 条,每条 {storyTime, event, participants}。
  storyTime 用故事内时间(如 "第七日夜"),不是章节号。
- summary:oneLiner ≤30 字;paragraph 100-200 字,写事件与因果,不写氛围;
  keyEvents 2-5 条 {event, characters, foreshadowingRefs}。

只输出:
{
  "characterStates": { "林尘": "在黑水镇客栈养伤,左臂中毒未愈,黑剑随身,对赵三起疑" },
  "records": { "境界": "炼气四层", "灵石": "37 枚" },
  "newForeshadow": [ { "label": "赵三的令牌", "description": "…", "relatedCharacters": ["赵三"] } ],
  "foreshadowPaid": ["黑剑来历"],
  "timeline": [ { "storyTime": "第七日夜", "event": "林尘识破赵三身份", "participants": ["林尘","赵三"] } ],
  "summary": { "oneLiner": "…", "paragraph": "…", "keyEvents": [ { "event": "…", "characters": ["…"], "foreshadowingRefs": [] } ] }
}

# 记录规则(本书要追踪的动态记录)
{{记录规则}}

# 角色名录(标准名)
{{角色名录}}

# 现有伏笔(未回收;foreshadowPaid 只能从这里逐字选)
{{现有伏笔}}

# 本章规划(参考,以正文实际为准)
{{本章规划}}

# 第 {{章号}} 章正文
{{正文}}
