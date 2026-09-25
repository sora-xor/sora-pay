/** Official-data providers for daily MUFG pricing and worldwide Japan Post EMS quotations. */
export * from './mufg.js';
export * from './japan-post.js';
export { SOURCES, fetchOfficialText } from './http.js';
export type { FetchOptions, SourceEvidence } from './http.js';
