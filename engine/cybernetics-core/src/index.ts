/**
 * @cybernetics/core -- Universal cybernetics library.
 *
 * Beer's VSM, Ashby, Wiener, and beyond.
 *
 * Re-exports all modules for convenient access:
 *   import { NodeId, Severity } from '@cybernetics/core';
 *   import { foundations, events, variety } from '@cybernetics/core';
 */

// Shared types -- flat re-export so consumers can import directly
export * from './types';

// Module namespaces
export * as foundations from './foundations';
export * as variety from './variety';
export * as algedonic from './algedonic';
export * as homeostat from './homeostat';
export * as metrics from './metrics';
export * as autopoiesis from './autopoiesis';
export * as constraints from './constraints';
export * as heterarchy from './heterarchy';
export * as conversation from './conversation';
export * as observer from './observer';
export * as events from './events';
export * as vsm from './vsm';
