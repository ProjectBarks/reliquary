import { Outlet } from '@tanstack/react-router'
import styled from 'styled-components'
import {
  Panel,
  Row,
  RowDesc,
  RowLabel,
  RowMain,
  Section,
  SectionHead,
  SectionNote,
  SectionTitle
} from '../dashboard/ui'

/**
 * The Codex tab's frame (#/codex) — for now a placeholder that only proves the
 * route exists and inherits the settings-gray surface language.
 *
 * It is deliberately shaped like the real thing already: a page wrap at the same
 * measure as Settings, one Section heading, and a Panel that hosts an <Outlet/>.
 * The compendium's sub-nav, bracket controls and pinned rail land in this same
 * frame later, so nothing above the Outlet has to move when they do.
 */
export function CodexLayout(): JSX.Element {
  return (
    <Wrap>
      <Section>
        <SectionHead>
          <SectionTitle>Codex</SectionTitle>
          <SectionNote>cards · relics · potions</SectionNote>
        </SectionHead>
        <Panel>
          <Outlet />
        </Panel>
      </Section>
    </Wrap>
  )
}

/**
 * The Codex index (#/codex). A single honest row rather than an empty panel —
 * a blank surface reads as a bug, a sentence reads as "not yet".
 */
export function CodexHome(): JSX.Element {
  return (
    <Row>
      <RowMain>
        <RowLabel>Codex — coming online</RowLabel>
        <RowDesc>
          The card, relic and potion compendium — with community win rates and tier lists — is
          being wired up. Nothing to see in here yet.
        </RowDesc>
      </RowMain>
    </Row>
  )
}

const Wrap = styled.div`
  max-width: 680px;
  margin: 0 auto;
  padding: 28px 24px 56px;
  @media (max-width: 520px) {
    padding: 20px 14px 40px;
  }
`
