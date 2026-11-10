/** AI 问答：检索 → LLM → 输出闸；答案带出处与"关联凭据"跳转。 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { Button, Empty, Spinner } from '../components/ui'

interface Citation { document_id: string; title: string; anchor: string; idx: number }
interface SecretRef { secret_id: string; name: string }
interface ChatResp {
  answer: string
  blocked?: boolean
  message?: string
  citations: Citation[]
  secret_refs: SecretRef[]
}

const SAMPLES = [
  '生产环境的部署步骤是什么？',
  '数据备份和恢复的流程？',
  '新人入职要配置哪些权限？',
]

export default function ChatPage() {
  const [q, setQ] = useState('')
  const [history, setHistory] = useState<Array<{ question: string; resp: ChatResp }>>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const go = async () => {
    if (!q.trim()) return
    setBusy(true); setErr('')
    try {
      const resp = await api.post<ChatResp>('/chat', { question: q })
      setHistory(h => [...h, { question: q, resp }])
      setQ('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : '问答失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="page-head">
        <h2>AI 问答</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          仅依据知识库作答；输出闸会拦截疑似凭据的回答（整段阻断）
        </span>
      </div>

      {history.length === 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <Empty text="向知识库提问，例如：" />
          <div className="toolbar" style={{ justifyContent: 'center' }}>
            {SAMPLES.map(s => <Button key={s} onClick={() => setQ(s)}>{s}</Button>)}
          </div>
        </div>
      )}

      {history.map((h, i) => (
        <div key={i} style={{ marginBottom: 18 }}>
          <div className="card" style={{ background: 'var(--brand-weak)', border: 'none' }}>
            <b>{h.question}</b>
          </div>
          <div className="card" style={{ marginTop: 8 }}>
            {h.resp.blocked
              ? <div className="blocked-banner">🚫 {h.resp.message ?? '本次回答可能包含凭据，已拦截'}</div>
              : <div className="chat-answer">{h.resp.answer}</div>}
            {h.resp.citations.length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                <span className="muted" style={{ fontSize: 12 }}>出处：</span>
                {h.resp.citations.map((c, j) => (
                  <div className="citation" key={j}>
                    《{c.title}》 · {c.anchor}
                  </div>
                ))}
              </div>
            )}
            {h.resp.secret_refs.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {h.resp.secret_refs.map((s, j) => (
                  <div key={j} className="citation">
                    关联凭据：<b>{s.name}</b> → <Link to="/secrets">前往密钥区查看（需解锁）</Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}

      <div className="card" style={{ position: 'sticky', bottom: 8 }}>
        {err && <div className="blocked-banner" style={{ marginBottom: 8 }}>{err}</div>}
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input type="text" style={{ flex: 1 }} placeholder="输入问题…"
            value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !busy) void go() }} />
          <Button kind="primary" disabled={busy} onClick={() => void go()}>
            {busy ? '检索 + 生成中…' : '提问'}
          </Button>
        </div>
        {busy && <Spinner text="检索 → LLM → 输出闸…" />}
      </div>
    </div>
  )
}
