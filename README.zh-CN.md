# Karen Game Studio

[English](./README.md) | **简体中文**

一个仓库装下的游戏开发工作室：给编码 agent 用的 Agent Skills，和准备游戏素材用的本地浏览器工具。

| 部分 | 是什么 | 位置 |
|---|---|---|
| Skills | 可独立安装的 Agent Skills | [`skills/`](./skills) |
| Tools | 离线运行的游戏素材浏览器工具 | [`tools/`](./tools/README.zh-CN.md) |

两部分互相独立。安装 skill 不会带上工具，工具也不需要任何 agent 就能跑。

## Skills

| Skill | 用途 |
|---|---|
| [`ui-preview-compare`](./skills/ui-preview-compare) | 改动正式代码之前，先把几个 UI 方向和现状（AS-IS）放在一起对比。 |

### 快速安装

```bash
npx skills add jiehaoZ/karen-game-studio \
  --skill ui-preview-compare
```

Skills CLI 会检测兼容的编码 agent，让你选择安装目标和范围。

### 示例

对你的编码 agent 说：

> 重新设计这个背包界面，让玩家更容易比较装备。

当请求里有还没定下来的视觉决策时，`ui-preview-compare` 会先展示当前的 AS-IS 状态和 2–3 个差异明确的方向，然后才改动正式代码。

### 安装选项

列出本仓库的所有 skill：

```bash
npx skills add jiehaoZ/karen-game-studio --list
```

加 `--global` 安装到用户级，或者用 `--agent <agent-name>` 指定某个兼容的 agent。本地开发时，把 `jiehaoZ/karen-game-studio` 换成本仓库的绝对路径。

## Tools

| 工具 | 用途 |
|---|---|
| [Canvas Aligner](./tools/aligner/README.zh-CN.md) | n 张图叠在同一个画布上，缩放到主体大小一致，导出 ZIP。 |
| [Matte](./tools/matte/README.zh-CN.md) | 纯色背景转透明。用成像方程反解，柔边和毛发不会被切平。 |

克隆仓库后双击 [`tools/index.html`](./tools/index.html) 打开工具板。所有工具都在浏览器里从 `file://` 直接运行：不上传、不联网、没有构建步骤、不需要安装。图片可以拖进去、点选，或者用 `⌘V` 粘贴。

两件工具的导出都会压到再降一档就要露出痕迹为止，每一档都用 SSIM 和原图比对。PNG 降的是调色板大小，WebP 和 JPEG 降的是画质。

工具板、共用的设计语言和怎么加新工具见 [`tools/README.zh-CN.md`](./tools/README.zh-CN.md)，每件工具的设计说明在它自己的 README 里。工具界面是中文的。

### 开发

单元测试只需要 Node。端到端测试通过 Playwright 驱动真实的 Chrome，所以要先在对应工具的目录里 `npm install`。

```bash
cd tools/aligner   # 或 tools/matte
node --test tests/*.test.js
npm install && node tests/e2e.mjs
```

## 仓库结构

```text
skills/
└── ui-preview-compare/
    └── SKILL.md
tools/
├── index.html      工具板
├── home.css
├── aligner/        Canvas Aligner
└── matte/          Matte
```

`skills/` 下的每个目录都是一个可独立安装的 Agent Skill。目录名必须和它 `SKILL.md` 里的 `name` 字段一致，它的脚本、参考文档和静态资源都放在这个目录内。

`tools/` 下的每个目录都是一件独立的工具，自带 `index.html`。

## 文档语言

各个 README 都有英文和简体中文两个版本：`README.md` 是英文（默认展示），`README.zh-CN.md` 是中文。

## 许可

MIT
