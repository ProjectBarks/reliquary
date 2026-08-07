import { Routes, Route, Navigate } from 'react-router-dom'
import { Shell } from './dashboard/Shell'
import { Sts2Overlay } from './overlays/sts2/Sts2Overlay'
import { TrackerMock } from './overlays/sts2/TrackerMock'

/**
 * One React bundle, two screens, selected by the window's hash route
 * (mirrors the original app):
 *   #/             -> Shell (frameless main window: Home / Debug / Logs tabs)
 *   #/overlay/sts2 -> Sts2Overlay (transparent, click-through overlay window)
 */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/overlay/sts2" element={<Sts2Overlay />} />
      {/* Design harness for the deck tracker: dev server only, never shipped. */}
      {import.meta.env.DEV ? <Route path="/mock/tracker" element={<TrackerMock />} /> : null}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
