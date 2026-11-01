import type { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export type { SQLInputValue, SQLOutputValue, StatementResultingChanges } from 'node:sqlite';
