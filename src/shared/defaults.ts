import type { ArchiveType, ScanSettings } from './types'

export function defaultScanDraft(): ScanSettings {
  return {
    targets: [],
    ignoreName: false,
    excludeHidden: false,
    excludeSystem: false,
    excludeJunction: true,
    excludeNodeModules: true,
    minSize: null,
    maxSize: null,
    extBlacklist: [],
    extWhitelist: [],
    scanArchives: true,
    archiveTypes: ['zip', '7z', 'rar'] as ArchiveType[],
    useEverything: true
  }
}
