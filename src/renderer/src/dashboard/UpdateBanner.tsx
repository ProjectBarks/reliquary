import { useEffect, useState } from 'react'
import styled, { keyframes } from 'styled-components'
import type { UpdateState } from '@shared/types'

/**
 * Update status, shown in the titlebar so it is visible from every tab.
 *
 * Deliberately quiet: while an update downloads this is a thin progress pill,
 * and it only becomes a button once there is something to act on. Nothing here
 * ever interrupts — the update installs on quit whether or not it is clicked.
 */
export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => window.spectra?.onUpdate(setState), [])

  if (!state) return null
  // Nothing worth saying: up to date, idle, or an unpackaged dev run.
  if (state.status !== 'downloading' && state.status !== 'ready') return null

  if (state.status === 'downloading') {
    return (
      <Pill title={`Downloading ${state.version ?? 'update'}…`}>
        <Dot />
        <span>Updating {state.percent > 0 ? `${state.percent}%` : ''}</span>
      </Pill>
    )
  }

  return (
    <Ready
      onClick={() => window.spectra?.updateAction('install')}
      title={`Restart to install ${state.version}`}
    >
      <span>Update ready</span>
      <em>Restart</em>
    </Ready>
  )
}

const pulse = keyframes`
  0%, 100% { opacity: 0.35 }
  50% { opacity: 1 }
`

const base = `
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 22px;
  padding: 0 10px;
  border-radius: 11px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
`

const Pill = styled.div`
  ${base}
  color: oklch(1 0 0 / 55%);
  background: oklch(1 0 0 / 6%);
  border: 1px solid oklch(1 0 0 / 8%);
`

const Dot = styled.span`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  animation: ${pulse} 1.4s ease-in-out infinite;
`

const Ready = styled.button`
  ${base}
  cursor: pointer;
  color: var(--sts-color-cream);
  background: color-mix(in oklch, var(--brand) 22%, transparent);
  border: 1px solid color-mix(in oklch, var(--brand) 45%, transparent);
  transition: background 120ms ease;

  &:hover {
    background: color-mix(in oklch, var(--brand) 34%, transparent);
  }

  em {
    font-style: normal;
    font-weight: 600;
    color: var(--brand);
  }
`
