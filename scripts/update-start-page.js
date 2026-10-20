import { readFile, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const page = new URL('../assets/start.html', import.meta.url);
const html = await readFile(page, 'utf8');
let labels = 0;
const updated = html.replace(/(<(?:title|p)>)Chrome Dialog MCP(?: [^<]+)?(?=<\/)/g, (_, tag) => {
  labels++;
  return `${tag}Chrome Dialog MCP ${version}`;
});
if (labels !== 2) throw new Error('Expected startup page title and label');
if (process.argv.includes('--check')) {
  if (html !== updated) throw new Error('Startup page version must match package.json; run node scripts/update-start-page.js');
} else if (html !== updated) {
  await writeFile(page, updated);
}
