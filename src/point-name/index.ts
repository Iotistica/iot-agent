export { createPointNameNormalizationInterceptor } from './interceptor.js';
export { getPointNameCatalog, resetPointNameCatalogForTests } from './catalog.js';
export type { CatalogMetrics, PointNameCatalog } from './catalog.js';
export { normalizePointName } from './normalize-point-name.js';
export { computeProvisionalPointId, computeShortHash, naturalKey } from './identity.js';
export { CURRENT_POINT_NAME_RULES_VERSION } from './types.js';
export type { PointIdentity, PointNameProvenance, Logger } from './types.js';
