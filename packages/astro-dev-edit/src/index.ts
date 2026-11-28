export { parse as parseAstroSource } from '@astrojs/compiler';
export {
  computeContentHash,
  computeSnapshotHash,
  countAstroParseErrors,
  findElementsByContentHash,
  inspectAstroElement,
  parseLoc,
  sha256,
  type EditabilityKind,
  type InspectOptions,
  type InspectResult,
  type SourceElement,
} from './ast-classifier.js';
export {
  detectAstroVersions,
  formatAstroVersions,
  getAstroCompat,
  inlineEditingDisabledReason,
  SUPPORTED_ASTRO_MAJORS,
  type AstroVersionInfo,
} from './compat.js';
export { PerFileMutex, type AsyncFileLock } from './file-lock.js';
export {
  halleyDevEdit,
  invalidateCssModulesForFile,
  resolveEditorRelFile,
  type HalleyDevEditOptions,
} from './integration.js';
export {
  discoverSiteRoutes,
  discoverSiteStructure,
  isPageSourceUnlisted,
  type SiteRouteEntry,
  type SiteStructureDiscovery,
} from './routes.js';
export {
  extractNavGroupsFromHtml,
  generatePageSkeleton,
  rewriteRelativeImportsInAstroSource,
  toggleMarkdownUnlistedInSource,
  togglePageUnlistedInSource,
  type GeneratePageSkeletonOptions,
  type GeneratePageSkeletonResult,
} from './skeleton.js';
export {
  patchStaticSpan,
  serializeHtmlToAstro,
  verifyPatchedSource,
  type PatchStaticSpanInput,
  type PatchStaticSpanResult,
  type SerializeOptions,
  type SerializeResult,
} from './serializer.js';
