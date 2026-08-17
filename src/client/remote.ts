/**
 * 任务板 client Remote contribution（手写，仿 generator 输出结构）。
 * @module dsh-agent-taskboard/client/remote
 */
import type { TypertRemoteContribution, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

const taskSchema = z.object({
  id: z.string(), title: z.string(), description: z.string(), type: z.string().optional(), priority: z.string(),
  tags: z.array(z.string()), status: z.string(), assignee: z.string().optional(),
  createdAt: z.string(), claimedAt: z.string().optional(), doneAt: z.string().optional(),
  summary: z.string().optional(),
})

const listResult: TypertCodec = { mode: 'strict', typeSymbol: 'taskboard#ListResult', schema: z.object({ tasks: z.array(taskSchema) }) }
const statusResult: TypertCodec = { mode: 'strict', typeSymbol: 'taskboard#StatusResult', schema: z.object({ counts: z.record(z.string(), z.number()) }) }
const mutateRequest: TypertCodec = { mode: 'strict', typeSymbol: 'taskboard#MutateRequest', schema: z.object({ taskId: z.string().optional(), action: z.string(), title: z.string().optional(), description: z.string().optional(), type: z.string().optional(), priority: z.string().optional(), summary: z.string().optional(), assignee: z.string().optional() }) }
const mutateResult: TypertCodec = { mode: 'strict', typeSymbol: 'taskboard#MutateResult', schema: z.union([z.object({ ok: z.literal(true), task: taskSchema.optional() }), z.object({ ok: z.literal(false), error: z.string() })]) }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    taskboard: {
      list: () => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ tasks: unknown[] }>>
      status: () => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ counts: Record<string, number> }>>
      mutate: (req: { taskId?: string; action: string; title?: string; description?: string; type?: string; priority?: string; summary?: string; assignee?: string }) => Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<{ ok: boolean; error?: string }>>
    }
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-agent-taskboard',
  descriptors: [
    {
      id: 'dsh-agent-taskboard#taskboard/list',
      service: 'taskboardRemote',
      namespace: 'taskboard',
      method: 'list',
      implementation: 'dsh-agent-taskboard',
      invocation: { kind: 'direct' },
      parameters: [],
      result: listResult,
      sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-agent-taskboard#taskboard/status',
      service: 'taskboardRemote',
      namespace: 'taskboard',
      method: 'status',
      implementation: 'dsh-agent-taskboard',
      invocation: { kind: 'direct' },
      parameters: [],
      result: statusResult,
      sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-agent-taskboard#taskboard/mutate',
      service: 'taskboardRemote',
      namespace: 'taskboard',
      method: 'mutate',
      implementation: 'dsh-agent-taskboard',
      invocation: { kind: 'direct' },
      // wire 必须与 host 方法形参名一致（SRC descriptor 从形参名推断：mutate(req) → 'req'）
      parameters: [{ name: 'req', wire: 'req', source: 'json', codec: mutateRequest }],
      result: mutateResult,
      sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
    },
  ],
}

export default TYPERT_REMOTE
