import { useTranslate } from '../../i18n/index.js'
import { memo, useMemo, useState } from 'react'
import type { Source } from '../../services/chat/view.js'
import { toMdAst } from '../../services/markdown/parse.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

/**
 * 单条正文超过该字符数时先按纯文本渲染。
 * 长历史里的超长消息如果直接走 AST → DOM，会生成上万个节点并同步解析，
 * 导入长上下文后整页卡死多半来自这里，因此默认降级，用户可手动要求格式化。
 */
const PLAIN_TEXT_LIMIT = 60_000

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 传入 sources 时把正文里的 [citation:N] 渲染为角标。
 * 超长正文先降级为纯文本，避免一次性展开成巨量 DOM。
 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const t = useTranslate()
  const scrollToBottom = useScrollToBottom()
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const [forceFormat, setForceFormat] = useState(false)
  const plain = !loading && !forceFormat && content.length > PLAIN_TEXT_LIMIT
  const ast = useMemo(
    () =>
      throttledMarkdown && !plain
        ? toMdAst(throttledMarkdown, { sources, disableLink })
        : null,
    [throttledMarkdown, sources, disableLink, plain]
  )
  if (plain) {
    return (
      <div className={className ? `${className} md-plain-text` : 'md-plain-text'}>
        <div className="md-plain-notice">
          <span>{t('markdownPlainNotice')}</span>
          <button type="button" className="md-plain-action" onClick={() => setForceFormat(true)}>
            {t('markdownPlainAction')}
          </button>
        </div>
        <pre>{content}</pre>
      </div>
    )
  }
  return ast ? (
    <MarkdownAstRenderer
      key={cacheKey}
      className={className}
      ast={ast}
      loading={loading}
      onUpdate={scrollToBottom}
    />
  ) : null
})
