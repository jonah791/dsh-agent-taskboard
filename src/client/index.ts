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
        apply: () => {
          // 2026-09-13 撤除 GUI 槽位（主人定调：GUI 只留 1 个入口——面板宿主的「面板」按钮）：
          // 原此处注册 `conversation.session.header.actions` 的「任务板」按钮（id=taskboard order=30）。
          // 任务板界面已迁为面板宿主里的一页（dsh-panel `panels/taskboard.ts`，id=taskboard）。
          // 保留 $mount 与 typert remote（宿主侧工具不受影响）；要恢复入口即在此重新 register。
        },
      })
      console.info('[taskboard] ui ready')
    } catch (err) {
      console.error('[taskboard] init fail:', err)
    }
  })()
}
