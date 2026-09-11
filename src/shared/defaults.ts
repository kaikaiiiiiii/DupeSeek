import type { ScanSettings } from './types'

export function defaultScanDraft(): ScanSettings {
  return {
    targets: [],
    ignoreName: false,
    excludeHidden: false,
    excludeSystem: false,
    excludeJunction: true,
    minSize: null,
    maxSize: null,
    extBlacklist: [],
    extWhitelist: []
  }
}
