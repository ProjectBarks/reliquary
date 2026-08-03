/// <reference types="vite/client" />
import type { SpectraApi } from '@shared/types'

declare global {
  interface Window {
    spectra: SpectraApi
  }
}

export {}
