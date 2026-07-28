import React, { useContext } from 'react'
import { JobsCtx } from '../App'

export default function JobStatus() {
  const { jobs, dismissJob } = useContext(JobsCtx)
  const visible = jobs.slice(0, 4)
  if (!visible.length) return null

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
                <div className="jt-txt">{j.progress} / {j.total} chapitres</div>
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
