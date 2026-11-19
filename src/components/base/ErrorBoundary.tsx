import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translate } from '../../i18n/index.js'
import { Button } from './Button.js'
import styles from './ErrorBoundary.module.css'

type Props = {
  children: ReactNode
  /** 变化时清空错误状态，用于切换会话后重试 */
  resetKey?: string
}

type State = { error: Error | null }

/**
 * 渲染兜底：消息列表里任何一条内容在渲染期抛错时，
 * React 会卸载整棵树变成白屏，这里把它降级成一张可重试的错误卡片。
 * 纯文本兜底不做，避免再次踩到同一个渲染分支。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[render] 渲染失败，已降级显示', error, info.componentStack)
  }

  override componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  override render() {
    const { error } = this.state
    if (!error) {
      return this.props.children
    }
    return (
      <div className={styles.fallback} role="alert">
        <p className={styles.title}>{translate('renderCrashTitle')}</p>
        <p className={styles.detail}>{translate('renderCrashDetail')}</p>
        <pre className={styles.message}>{error.message}</pre>
        <div className={styles.actions}>
          <Button variant="outlined" size="s" onClick={() => this.setState({ error: null })}>
            {translate('retry')}
          </Button>
        </div>
      </div>
    )
  }
}

