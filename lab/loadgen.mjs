#!/usr/bin/env node
// Convenience wrapper:  node lab/loadgen.mjs <subject> [options]  ==  node <subject>/loadgen/loadgen.mjs [options]
// Each subject carries its own self-contained load generator.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const [subject, ...rest] = process.argv.slice(2);
if (!subject) { console.error('usage: node lab/loadgen.mjs <shopflow|ledgerline> [options]'); process.exit(2); }
const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '..', subject, 'loadgen', 'loadgen.mjs'), ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
