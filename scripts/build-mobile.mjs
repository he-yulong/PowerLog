// Generate a read-only website from the real workbook. No network or workbook writes.
import path from 'node:path';
import { root, buildSnapshot, snapshotHtml, writeSite, summary } from './snapshot.mjs';

const python = process.argv[2] || 'python';
// Existing Site workflow may return another checkout; pass it as the third argument.
const checkout = path.resolve(process.argv[3] || path.join(root, '.powerlog-runtime/mobile-site'));
const snapshot = await buildSnapshot(python);
await writeSite(path.join(checkout, 'out'), snapshot, await snapshotHtml());
console.log(summary(snapshot, { checkout }));
