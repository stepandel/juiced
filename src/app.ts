import { fleet } from './cantelop.js';

// Self-managed App profiles and managed service relays share the compiled Fleet contract.
export const app = fleet.connect();
