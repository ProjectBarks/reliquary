import styled from 'styled-components'

/**
 * Shared dashboard styling primitives, in the StS2 companion aesthetic:
 * Kreon headers, gold/cream/aqua accents, dark translucent panels with a hard
 * offset drop-shadow. Reused across the Home / Debug / Logs tabs so every screen
 * reads as one app.
 */

export const Card = styled.div`
  background: rgba(38, 35, 33, 0.66);
  border: 1px solid oklch(1 0 0 / 10%);
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: 5px 5px 0 oklch(0 0 0 / 25%);
`

export const CardTitle = styled.h2`
  font-family: 'Kreon', serif;
  font-size: 19px;
  letter-spacing: 0.5px;
  color: var(--brand);
  margin: 0 0 12px;
  text-shadow: 2px 2px 0 oklch(0 0 0 / 45%);
`

export const Hint = styled.p`
  margin: 0 0 10px;
  font-size: 13px;
  color: #9c9384;
`

export const Status = styled.div<{ ok?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  margin: 4px 0;
  &::before {
    content: '';
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: 0 0 auto;
    background: ${(p) => (p.ok ? 'var(--sts-color-green)' : 'var(--sts-color-red)')};
    box-shadow: 0 0 8px ${(p) => (p.ok ? 'var(--sts-color-green)' : 'transparent')};
  }
`

export const Mono = styled.div`
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  color: #9c9384;
  margin: 2px 0 2px 17px;
  &.err {
    color: var(--sts-color-red);
    word-break: break-word;
  }
`
