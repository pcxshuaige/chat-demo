import { translate } from '../../i18n/index.js'
import type { MessageParam } from '../api/types.js'

/**
 * 上下文预算：deepseek 系列单次请求可用上下文为 128K token。
 * 这里给模型输出、思考、工具结果预留余量，默认按 96K token 控制历史体积。
 * 用户可通过 localStorage 的 chat-demo.contextBudget 覆盖（单位 token）。
 */
const DEFAULT_TOKEN_BUDGET = 96_000

const BUDGET_STORAGE_KEY = 'chat-demo.contextBudget'

const readBudgetOverride = (): number | null => {
  try {
    const raw = window.localStorage.getItem(BUDGET_STORAGE_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value >= 2_000 ? Math.floor(value) : null
  } catch {
    return null
  }
}

/** 本轮可用的输入预算（token） */
export const getContextTokenBudget = (): number => readBudgetOverride() ?? DEFAULT_TOKEN_BUDGET

/** 单条消息最多占用的预算比例，超出部分会被截断，避免一条超长消息独占上下文 */
const SINGLE_MESSAGE_RATIO = 0.5
/** 截断提示至少保留的上下文长度，防止反复截断 */
const MIN_CLIP_TOKENS = 512

/**
 * 估算文本的 token 数：CJK 等宽字符按 1 token/字，
 * 其余（英文、代码、标点）按 3.5 字符/token。故意偏保守，宁可少发也不撞上限。
 */
export const estimateTokens = (text: string): number => {
  let wide = 0
  let narrow = 0
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) >= 0x2e80) {
      wide += 1
    } else {
      narrow += 1
    }
  }
  return wide + Math.ceil(narrow / 3.5)
}

/** 单条请求消息的估算成本；结构化序列化后按字符估算，附件块只计固定开销 */
const messageTokens = (message: MessageParam): number => estimateTokens(JSON.stringify(message))

/**
 * 按 user 提问切分轮次：latest_reminder 归属于其后的提问，
 * 提问后的 assistant（含续写前缀）跟随该轮一起进退。
 */
const splitRounds = (messages: MessageParam[]): MessageParam[][] => {
  const rounds: MessageParam[][] = []
  let pending: MessageParam[] = []
  let current: MessageParam[] | null = null
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      pending.push(message)
      continue
    }
    if (message.role === 'user') {
      current = [...pending, message]
      pending = []
      rounds.push(current)
      continue
    }
    if (current) {
      current.push(message)
    } else {
      current = [message]
      rounds.push(current)
    }
  }
  if (pending.length > 0) {
    if (current) {
      current.push(...pending)
    } else {
      rounds.push(pending)
    }
  }
  return rounds
}

const clipText = (text: string, limit: number): string => {
  if (estimateTokens(text) <= limit) {
    return text
  }
  // 按 token 与字符的比例折算需要保留的字符数，再留 10% 余量
  const ratio = text.length / Math.max(1, estimateTokens(text))
  const keep = Math.max(MIN_CLIP_TOKENS, Math.floor(limit * 0.9 * ratio))
  const head = Math.floor(keep * 0.75)
  const tail = keep - head
  return `${text.slice(0, head)}\n\n${translate('contextTruncated', {
    count: text.length - head - tail,
  })}\n\n${text.slice(text.length - tail)}`
}

/**
 * 把单条消息压缩到给定 token 上限内：文本块按头尾保留，思考块整体缩短，
 * 工具块保留（体积小且服务端需要与调用配对），附件块原样保留。
 */
const shrinkMessage = (message: MessageParam, limit: number): MessageParam => {
  if (message.role === 'latest_reminder') {
    return { ...message, content: clipText(message.content, limit) }
  }
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return { ...message, content: clipText(message.content, limit) }
    }
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === 'text' ? { ...block, text: clipText(block.text, limit) } : block
      ),
    }
  }
  const content = message.content.map((block) => {
    if (block.type === 'text') {
      return { ...block, text: clipText(block.text, limit) }
    }
    if (block.type === 'thinking') {
      return { ...block, thinking: clipText(block.thinking, Math.min(limit, MIN_CLIP_TOKENS)) }
    }
    return block
  })
  return { ...message, content }
}

export type ContextBudgetResult = {
  messages: MessageParam[]
  /** 被省略的较早轮次数 */
  droppedRounds: number
  /** 是否发生了单条消息截断 */
  truncated: boolean
  /** 裁剪后的估算 token 数 */
  estimatedTokens: number
}

/**
 * 把请求消息裁剪到预算内：
 * 1. 从最后一轮向前保留完整轮次，超出的较早轮次整轮丢弃；
 * 2. 最后一轮始终保留，单条消息仍超预算时按头尾截断。
 * 返回的数组顺序与原数组一致，保证以 user 提问开头。
 */
export const fitMessagesToBudget = (
  messages: MessageParam[],
  budget = getContextTokenBudget()
): ContextBudgetResult => {
  const total = messages.reduce((sum, message) => sum + messageTokens(message), 0)
  if (total <= budget) {
    return { messages, droppedRounds: 0, truncated: false, estimatedTokens: total }
  }
  const rounds = splitRounds(messages)
  const singleLimit = Math.max(MIN_CLIP_TOKENS, Math.floor(budget * SINGLE_MESSAGE_RATIO))
  let used = 0
  let firstKept = rounds.length
  let truncated = false
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]
    if (!round) {
      break
    }
    const cost = round.reduce((sum, message) => sum + messageTokens(message), 0)
    const isLast = index === rounds.length - 1
    if (!isLast && used + cost > budget) {
      break
    }
    used += cost
    firstKept = index
  }
  const kept: MessageParam[] = []
  for (let index = firstKept; index < rounds.length; index += 1) {
    const round = rounds[index]
    if (!round) {
      continue
    }
    for (const message of round) {
      if (messageTokens(message) <= singleLimit) {
        kept.push(message)
        continue
      }
      truncated = true
      kept.push(shrinkMessage(message, singleLimit))
    }
  }
  const estimatedTokens = kept.reduce((sum, message) => sum + messageTokens(message), 0)
  return {
    messages: kept,
    droppedRounds: firstKept,
    truncated,
    estimatedTokens,
  }
}
