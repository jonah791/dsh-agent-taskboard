/**
 * 任务板会话头动作：按钮 + 右侧滑入面板（发布/分组列表/操作）。
 * 精美版：类型分组（短期/长期）、彩色状态徽章、优先级色点、入场动画。
 * @module dsh-agent-taskboard/client/TaskboardAction
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './remote.ts'

export interface TaskView {
  id: string; title: string; description: string; type: string; priority: string;
  tags: string[]; status: string; assignee?: string;
  createdAt: string; claimedAt?: string; doneAt?: string; summary?: string
}

export type TaskboardActionProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'taskboard'>

const C = {
  surface: 'var(--color-surface, #171a21)',
  border: 'rgba(127,127,127,.22)',
  text: 'var(--color-text, #e6e6e6)',
  textDim: 'rgba(140,145,160,.85)',
  primary: 'var(--color-primary, #4a7dff)',
  short: '#5b8cff',
  long: '#a78bfa',
}
const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: '待办', color: '#8ab4ff', bg: 'rgba(90,140,255,.14)' },
  claimed: { label: '进行中', color: '#ffb057', bg: 'rgba(255,176,87,.14)' },
  done: { label: '已完成', color: '#5fd08a', bg: 'rgba(95,208,138,.14)' },
  cancelled: { label: '已取消', color: '#9aa3b5', bg: 'rgba(154,163,181,.14)' },
}
const PRI_COLOR: Record<string, string> = { high: '#ff5f56', normal: '#ffb057', low: '#5fd08a' }
const PRI_LABEL: Record<string, string> = { high: '高', normal: '中', low: '低' }

function fmtTime(iso: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  return d + ' 天前'
}

export function TaskboardAction({ remote }: TaskboardActionProps & { remote?: any }) {
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [title, setTitle] = useState('')
  const [type, setType] = useState<'short' | 'long'>('short')
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal')
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await remote?.taskboard.list()
      if (list?.ok) setTasks(list.value?.tasks ?? [])
      const st = await remote?.taskboard.status()
      if (st?.ok) setCounts(st.value?.counts ?? {})
    } catch (err) { console.error('[taskboard] refresh fail:', err) }
  }, [remote])

  useEffect(() => {
    if (!open) return
    void refresh()
    panelRef.current?.animate(
      [{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open, refresh])

  const mutate = async (taskId: string, action: string, summary?: string) => {
    try {
      const r = await remote?.taskboard.mutate({ taskId, action, summary })
      if (r?.ok) void refresh()
    } catch (err) { console.error('[taskboard] mutate fail:', err) }
  }

  const post = async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const r = await remote?.taskboard.mutate({ action: 'post', title: t, type, priority })
      if (r?.ok) {
        setTitle('')
        void refresh()
      } else {
        console.error('[taskboard] post rejected:', JSON.stringify(r))
      }
    } catch (err) { console.error('[taskboard] post throw:', err) }
    setBusy(false)
  }

  const pending = counts.pending ?? 0
  const shortTasks = tasks.filter((t) => (t.type ?? 'short') === 'short')
  const longTasks = tasks.filter((t) => (t.type ?? 'short') === 'long')
  const openCount = (arr: TaskView[]) => arr.filter((t) => t.status === 'pending' || t.status === 'claimed').length

  const renderGroup = (label: string, accent: string, arr: TaskView[], empty: string) => (
    <div style={{ marginTop: '2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 2px 4px' }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '3px', background: accent, display: 'inline-block' }} />
        <span style={{ fontSize: '11.5px', fontWeight: 700, color: C.text, letterSpacing: '.02em' }}>{label}</span>
        {arr.length > 0 && (
          <span style={{ fontSize: '10.5px', color: C.textDim, background: 'rgba(127,127,127,.12)', borderRadius: '8px', padding: '0 6px' }}>{arr.length}</span>
        )}
        {openCount(arr) > 0 && (
          <span style={{ fontSize: '10px', color: accent, background: 'transparent', border: '1px solid ' + accent + '55', borderRadius: '8px', padding: '0 6px' }}>活跃 {openCount(arr)}</span>
        )}
      </div>
      {arr.length === 0 ? (
        <div style={{ fontSize: '12px', color: C.textDim, padding: '10px 2px', textAlign: 'center' }}>{empty}</div>
      ) : (
        arr.map((task) => {
          const sm = STATUS_META[task.status] ?? STATUS_META.pending
          const pc = PRI_COLOR[task.priority] ?? PRI_COLOR.normal
          return (
            <div key={task.id} data-task-id={task.id} style={{ display: 'flex', gap: '9px', padding: '7px 6px', borderRadius: '9px', margin: '1px 0', transition: 'background .12s ease', cursor: 'default', borderLeft: '3px solid ' + sm.color, background: 'rgba(127,127,127,.04)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 600, color: C.text, wordBreak: 'break-all' }}>{task.title}</span>
                  {task.summary && <span style={{ fontSize: '11px', color: C.textDim }}>· {task.summary}</span>}
                </div>
                <div style={{ fontSize: '10.5px', color: C.textDim, marginTop: '2px', display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <span style={{ color: pc, display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: pc, display: 'inline-block' }} />
                    {PRI_LABEL[task.priority] ?? task.priority}优先级
                  </span>
                  <span>{task.id}</span>
                  <span>{fmtTime(task.createdAt)}</span>
                  {task.assignee && <span>· {task.assignee}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-end', justifyContent: 'center' }}>
                <span style={{ fontSize: '10px', color: sm.color, background: sm.bg, borderRadius: '7px', padding: '1px 7px', fontWeight: 600 }}>{sm.label}</span>
                <div>
                  {task.status === 'pending' && <button style={btnStyle('#5b8cff')} onClick={() => void mutate(task.id, 'claim')}>领取</button>}
                  {task.status === 'claimed' && <button style={btnStyle('#5fd08a')} onClick={() => void mutate(task.id, 'complete')}>完成</button>}
                  {(task.status === 'pending' || task.status === 'claimed') && <button style={btnStyle('#9aa3b5')} onClick={() => void mutate(task.id, 'cancel')}>取消</button>}
                  {(task.status === 'done' || task.status === 'cancelled') && <button style={btnStyle('#8ab4ff')} onClick={() => void mutate(task.id, 'reopen')}>重开</button>}
                  <button style={btnStyle('#ff5f56')} onClick={() => void mutate(task.id, 'delete')} title="删除任务">删除</button>
                </div>
              </div>
            </div>
          )
        })
      )}
    </div>
  )

  const seg = (active: boolean, color: string): any => ({
    border: '1px solid ' + (active ? color : C.border),
    borderRadius: '6px',
    padding: '2px 9px',
    fontSize: '11px',
    cursor: 'pointer',
    background: active ? color + '22' : 'transparent',
    color: active ? color : C.textDim,
    transition: 'all .12s ease',
    fontWeight: active ? 700 : 400,
  })

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: '6px' }}>
      <button
        style={{ border: '1px solid ' + C.border, borderRadius: '8px', padding: '3px 10px', fontSize: '12px', cursor: 'pointer', background: 'transparent', color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'border-color .12s ease, background .12s ease' }}
        onClick={() => setOpen((v) => !v)}
        title="任务板"
      >
        任务板
        {pending > 0 && (
          <span style={{ background: 'linear-gradient(135deg, #4a7dff, #7a5cff)', color: '#fff', fontSize: '10px', fontWeight: 700, borderRadius: '9px', padding: '0 6px', minWidth: '16px', textAlign: 'center' }}>{pending}</span>
        )}
      </button>
      {open && (
        <div ref={panelRef} style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: '0', zIndex: 40,
          width: '480px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(560px, calc(100vh - 120px))', overflowY: 'auto',
          border: '1px solid ' + C.border, borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(255,255,255,.03), transparent 40%), ' + C.surface,
          boxShadow: '0 16px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03) inset',
          padding: '12px 14px', fontSize: '13px', color: C.text,
        }}>
          {/* 头部 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, letterSpacing: '.03em', background: 'linear-gradient(90deg, #8ab4ff, #c4a7ff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>任务板</span>
            <button onClick={() => setOpen(false)} style={{ border: 'none', background: 'transparent', color: C.textDim, fontSize: '14px', cursor: 'pointer', borderRadius: '6px', width: '24px', height: '24px', lineHeight: '20px' }}>✕</button>
          </div>
          {/* 发布区 */}
          <div style={{ background: 'rgba(127,127,127,.07)', borderRadius: '12px', padding: '9px', display: 'flex', flexDirection: 'column', gap: '7px', border: '1px solid ' + C.border }}>
            <input
              placeholder="输入新任务…（回车发布）"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void post() }}
              style={{ width: '100%', boxSizing: 'border-box', border: '1px solid ' + C.border, borderRadius: '8px', padding: '5px 9px', fontSize: '12.5px', background: 'rgba(0,0,0,.2)', color: C.text, outline: 'none' }}
            />
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button style={seg(type === 'short', C.short)} onClick={() => setType('short')}>短期</button>
              <button style={seg(type === 'long', C.long)} onClick={() => setType('long')}>长期</button>
              <span style={{ flex: 1 }} />
              <button style={seg(priority === 'low', PRI_COLOR.low)} onClick={() => setPriority('low')}>低</button>
              <button style={seg(priority === 'normal', PRI_COLOR.normal)} onClick={() => setPriority('normal')}>中</button>
              <button style={seg(priority === 'high', PRI_COLOR.high)} onClick={() => setPriority('high')}>高</button>
              <button onClick={() => void post()} style={{ border: 'none', borderRadius: '8px', padding: '4px 14px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'linear-gradient(135deg, #4a7dff, #7a5cff)', color: '#fff', opacity: busy ? .6 : 1 }}>
                发布
              </button>
            </div>
          </div>
          {/* 分组列表 */}
          {renderGroup('短期任务', C.short, shortTasks, '暂无短期任务')}
          {renderGroup('长期任务', C.long, longTasks, '暂无长期任务')}
          {tasks.length === 0 && <div style={{ color: C.textDim, textAlign: 'center', padding: '18px 0', fontSize: '12px' }}>还没有任务，先发布一个吧 (´▽｀)</div>}
        </div>
      )}
    </div>
  )
}

function btnStyle(color: string): any {
  return {
    border: '1px solid ' + color + '66',
    borderRadius: '6px', padding: '1px 8px', fontSize: '10.5px', cursor: 'pointer',
    background: color + '14', color, marginRight: '3px', transition: 'background .12s ease',
  }
}
