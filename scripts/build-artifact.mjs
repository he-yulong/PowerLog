// Generate the private Claude Artifact copy (page plus supporting files). No network or workbook writes.
import path from 'node:path';
import { root, buildSnapshot, snapshotHtml, writeSite, summary } from './snapshot.mjs';

const python = process.argv[2] || 'python';
const output = path.resolve(process.argv[3] || path.join(root, '.powerlog-runtime/artifact'));
const snapshot = await buildSnapshot(python);
// Artifact hosting wraps the page in its own document skeleton (charset, viewport),
// so keep only the title, the PowerLog head assets and the body content.
const page = (await snapshotHtml())
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?(?:html|head|body)\b[^>]*>\s*/g, '')
  .replace(/\s*<meta (?:charset|name="viewport")[^>]*>/g, '')
  .replace(/<title>[^<]*<\/title>/, '<title>PowerLog</title>');
await writeSite(output, snapshot, page, 'powerlog.html');
console.log(summary(snapshot, { output }));
