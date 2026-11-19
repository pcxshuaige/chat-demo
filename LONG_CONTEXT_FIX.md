# 长上下文修复说明

这个 fork 针对「导入长历史后一聊天就卡死/白屏」做了五处改造，全部是前端本地行为，不改动 API 协议、不改动数据结构、不迁移已有 IndexedDB 数据。

## 1. 请求层：上下文预算裁剪

新增 `src/services/chat/contextBudget.ts`，在 `src/services/chat/store.ts` 的 `streamReply` 里，`toRequestMessages` 之后插入 `fitMessagesToBudget`。

- 默认预算 **96K token**（deepseek 系列单请求 128K，给输出、思考、工具结果留余量）。
- 估算方式：CJK 字符按 1 token/字，其余按 3.5 字符/token，偏保守。
- 裁剪单位是「轮次」：从最后一轮往前保留，超预算的较早轮次整轮丢弃，不会出现 user/assistant 错位。
- 最后一轮永远保留；单条消息仍超预算（超过预算的 50%）时按头尾截断，中间插入省略提示。
- 裁剪发生时用 toast 告知：省略了多少轮，或有单条消息被截断。

覆盖预算（单位 token）：

```js
localStorage.setItem('chat-demo.contextBudget', '64000') // 更保守
localStorage.removeItem('chat-demo.contextBudget')       // 回到默认 96K
```

## 2. 渲染层：单条消息渲染隔离

`src/components/messages/MessageList.tsx` 给每条消息加了 `.row` 包裹层，`MessageList.module.css` 里：

```css
.row {
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;
}
```

视口外的消息不再参与布局与绘制，长历史滚动时不再整列重排。

## 3. 超长正文降级为纯文本

`src/components/markdown/Markdown.tsx`：单条正文超过 **60,000 字符**时不再走 micromark 解析 → AST → DOM，直接以纯文本渲染，并给一个「格式化渲染」按钮让用户按需展开。这是导入长历史后首屏卡死的主要来源。

## 4. 代码高亮与图表限长

- `src/components/markdown/CodeBlock.tsx`：代码块超过 **20,000 字符**时跳过 Prism 词法高亮，只做 HTML 转义；mermaid 代码超过 **8,000 字符**时按普通代码显示，不再交给 mermaid 渲染。
- `markdown.css` 给 `.md-code-block pre` 加 `contain: paint`，滚动不再触发整页绘制失效。

## 5. 滚动与落库

- `MessageList.tsx`：`ResizeObserver` 回调合并到一次 `requestAnimationFrame`，且已经贴底时不再写 `scrollTop`，切断「写入 → 尺寸变化 → 再写入」的回流链。
- `store.ts`：`persist` 拆成 `writeSession`（真正写库）+ 250ms 合并窗口；页面隐藏、`pagehide`、导入替换前走 `flushPersist` 立即落库。长会话不再每次改动都整包克隆写一次。

## 6. 渲染兜底

新增 `src/components/base/ErrorBoundary.tsx`，在 `App.tsx` 里包住 `SessionView`（`resetKey={session.id}`）。任何一条消息在渲染期抛错时只降级成一张可重试的错误卡片，不再整页白屏。

## 构建

```bash
pnpm install
pnpm type    # 通过
pnpm lint    # 通过
pnpm build
```

`pnpm build` 里的 `rm -rf dist` 在 Windows 上会被 cmd 拦截，本地直接跑：

```bash
NODE_ENV=production npx rspack build -c rspack.config.ts
```
