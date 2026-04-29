# server/style-pipeline/ — 风格提取流水线

**Nodesign 第二条核心通路**：用户上传参考素材（PPT / PDF / HTML）→ 提取结构化 style tokens → 喂给 engine 下游。

## 为什么这个模块独立于 engine

组长释放的产品意图：当前 deskskill-engine 是"brief → metaphor 推导 → deck"单管道，但真实需求是"风格参考"——用户上传已有 deck，想保留其视觉语言做新内容。

**这事儿是后端工程问题，不是 skill 问题**：色板抽样、字体识别、spacing 测量、layout grid 推断——按训练分布让 LLM 用 declarative 路径描述风格会丢精度（procedural / declarative 能力诊断已知）。所以做工程化提取，输出结构化 tokens 喂 skill 下游。

## 输入 / 输出契约（待设计）

**输入**：
- `application/pdf` — PDF 演示稿
- `.pptx` — PowerPoint
- `.html` — 已有 HTML deck（最干净，可能首推 MVP）

**输出**：`StyleTokens` 结构化 JSON（schema 待定），大致：
```json
{
  "palette": {
    "background": ["#fffaf0", "#f0e8d8"],
    "foreground": ["#1a1a1a", "#666"],
    "accent": ["#c83e3e"]
  },
  "typography": {
    "display": { "family": "...", "weight": 800, "tracking": "-0.02em" },
    "body":    { "family": "...", "weight": 400, "size_clamp": "..." }
  },
  "spacing": { "rhythm": [4, 8, 16, 32, 64], "page_padding": "..." },
  "layout": { "grid": "12-col" | "asymmetric" | ..., "alignment": "..." },
  "motion_signals": [...],   // 如果是 HTML，可静态扫到 transition / animation
  "metaphor_hints": "..."    // 可选：让 LLM 看一眼后给一句话直觉总结
}
```

## 技术路线候选（动工前需先做根因诊断）

⚠️ **先别选实现方式**。组长说之前用模版 skill 试过风格参考路径效果不好——根因待诊断（参 [HANDOVER.md](../../HANDOVER.md) §六）。

提取技术几条候选路线：
- **PDF / PPTX**：`pdf2htmlEX` / `python-pptx` / `LibreOffice headless` 转中间格式后扫
- **HTML**：DOM + computed style 直接读
- **视觉路径**：截图 → vision model（Kimi K2.6 / Claude Opus）描述 + 关键元素裁切
- **混合**：DOM 提骨架 + vision 提语义（推荐）

## 与 engine 的接口

style-pipeline 输出的 `StyleTokens` 作为 engine `runs` 的 `inputs.style_reference` 传入，engine 在加载 deskskill-engine 时把 tokens 注入 system prompt 一段，让 metaphor 推导跟 reference 对话（不是替代 metaphor）。

## 责任划分

负责人：你。新东西。
