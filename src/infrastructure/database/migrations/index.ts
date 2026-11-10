import { migration001Initial } from './001-initial';
import type { Migration } from './types';

export const migrations: Migration[] = [migration001Initial];
export type { Migration };
