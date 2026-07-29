import React, { useContext, useState, useEffect } from 'react'
import { JobsCtx } from '../contexts'

export default function JobStatus() {
  const { jobs, dismissJob } = useContext(JobsCtx)
  const [frame, setFrame] = useState(0)
  const visible = jobs.slice(0, 4)

  useEffect(() => {
    if (!visible.length) return undefined
    const interval = setInterval(() => setFrame(f => (f + 1) % 8), 100)
    return () => clearInterval(interval)
  }, [visible.length])

  if (!visible.length) return null

  const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']
  const spinner = spinners[frame]

  return (
    <div className="jobs-wrap">
      {visible.map((j) => {
        const pct = j.total > 0 ? (j.progress / j.total) * 100 : 0
        return (
          <div key={j.id} className="job-toast">
            <div className="jt-head">
              <div className={`jt-dot ${j.status}`} />
              <div className="jt-name">{j.manga_name} — {j.category}</div>
              {(j.status === 'done' || j.status === 'error') && (
                <button className="jt-x" onClick={() => dismissJob(j.id)}>✕</button>
              )}
            </div>
            {j.status === 'running' && (
              <>
                <div className="jt-bar"><div className="jt-fill" style={{ width: `${pct}%` }} /></div>
                <div className="jt-txt"><span className="jt-spin">{spinner}</span> {j.progress} / {j.total} éléments</div>
              </>
            )}
            {j.status === 'done' && <div className="jt-txt jt-done">✓ Terminé</div>}
            {j.status === 'error' && <div className="jt-txt jt-err">{j.error}</div>}
          </div>
        )
      })}
    </div>
  )
}
