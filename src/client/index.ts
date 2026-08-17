/**
 * 任务板 client 插件：$mount remote + 会话头动作面板。
 * 结构对齐官方（api-remotes 先 mount，消费方 inject namespace）：
 * apply 内先 await $mount 注册 remote.taskboard，再动态建消费 fiber
 * （动态插件的 inject 在 mount 后解析，boot 不卡）。
 * @module dsh-agent-taskboard/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TaskboardAction } from './TaskboardAction.tsx'
import TYPERT_REMOTE from './remote.ts'

export type { TaskboardActionProps, TaskView } from './TaskboardAction.tsx'
export { TYPERT_REMOTE }

export const inject = ['slots', 'remote'] as const

export function apply(ctx: ClientContext): void {
  void (async () => {
    try {
      await ctx.remote.$mount(TYPERT_REMOTE)
      await ctx.plugin({
        name: 'taskboard-ui',
        inject: ['slots', 'remote', 'remote.taskboard'],
        apply: (child) => {
          child.slots.inject(
            'conversation.session.header.actions',
            () => child.slots.register({
              name: 'conversation.session.header.actions',
              id: 'taskboard',
              order: 30,
              inject: () => ({ remote: child.remote }),
            }, TaskboardAction),
          )
        },
      })
      console.info('[taskboard] ui ready')
    } catch (err) {
      console.error('[taskboard] init fail:', err)
    }
  })()
}
