export { parse as parseAstroSource } from '@astrojs/compiler';
export {
  computeContentHash,
  computeOuterHash,
  countElementNodes,
  countMalformedElements,
  findElementsByOuterHash,
  locForElementStartingAt,
  computeSnapshotHash,
  countAstroParseErrors,
  findElementsByContentHash,
  ALLOWED_INLINE_TAGS,
  PROTECTED_LANDMARK_TAGS,
  collectSubtreeLocs,
  inspectAstroElement,
  parseLoc,
  sha256,
  type EditabilityKind,
  type InspectOptions,
  type SourceElement,
  type ElementCapabilities,
  type ElementContextInfo,
  type ImageCapability,
  type InspectResult,
  type LinkCapability,
  type ObjectPositionValue,
  type SpacingValue,
  type StructuralCapability,
  type StyleCapability,
  type TextAlignValue,
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
  listSiteImages,
  resolveImageTargetRelDir,
  writeSiteImage,
  type SiteImageEntry,
  type WriteSiteImageInput,
  type WriteSiteImageResult,
} from './images.js';
export {
  halleyDevEdit,
  invalidateCssModulesForFile,
  resolveEditorRelFile,
  type HalleyDevEditOptions,
} from './integration.js';
export {
  applyTailwindStylePresets,
  mutateAstroElement,
  rewriteOpeningTagAttrs,
  type AddBlockKind,
  type ElementMutation,
  type MutateElementInput,
  type MutateElementResult,
  type MutationExpectation,
  verifyMutatedSource,
} from './mutations.js';
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
export {
  EditUndoStack,
  type UndoEntry,
  type UndoRedoResult,
} from './undo-stack.js';
