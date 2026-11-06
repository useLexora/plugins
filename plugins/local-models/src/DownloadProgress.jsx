import React, { useEffect, useState } from 'react'
import { Badge, Progress } from '@mantine/core'
import { downloadActive, downloadPresentation } from './downloadPresentation'
import './transfers.css'

export function DownloadProgress({ job, compact = false }) {
  const [now, setNow] = useState(Date.now)
  const active = downloadActive(job)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, job.id])
  const data = downloadPresentation(job, now)
  return <div className={`download-progress lm-transfer-progress${compact ? ' is-compact lm-transfer-progress-compact' : ''}`} data-download-phase={data.phase} data-download-state={job.state}>
    <div className="download-progress-summary lm-transfer-progress-summary"><Badge component="span" className={`model-state model-state--${data.tone} lm-transfer-badge`} color={job.state === 'failed' ? 'red' : 'gray'} variant="light" size="sm" radius="sm" role="status">{data.label}</Badge>{data.percent !== null && <strong className="download-percent lm-transfer-percent">{data.percent}%</strong>}</div>
    {data.active && <Progress.Root className="lm-transfer-meter" size={6} role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.percent ?? undefined} aria-valuetext={data.percent === null ? data.label : `${data.percent}%`}><Progress.Section value={data.percent ?? 100} animated={data.percent === null} withAria={false} /></Progress.Root>}
    <div className="download-numbers lm-transfer-numbers"><span>{data.amount}</span>{data.rate && <span>{data.rate}</span>}</div>
    {data.waiting && <span className="download-waiting lm-transfer-waiting" role="status">{data.waiting}</span>}
    {data.active && job.progress?.path && <span className="download-file lm-transfer-file" title={job.progress.path}>{job.progress.path}</span>}
    {job.message && !data.active && <span className={job.state === 'failed' ? 'lm-transfer-error' : 'lm-transfer-note'}>{job.message}</span>}
  </div>
}
