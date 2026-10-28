import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, EXT_PATH, ARTIFACTS } from './mcp-client.mjs';

mkdirSync(ARTIFACTS, { recursive: true });
const mcp = new McpClient();

try {
  await mcp.start();

  const tools = await mcp.request('tools/list', {}, 60000);
  writeFileSync(path.join(ARTIFACTS, 'tools.json'), JSON.stringify(tools, null, 2));
  const names = (tools.tools ?? []).map((t) => t.name);
  console.log('== TOOLS ==');
  console.log(names.join(', '));
  console.log('== EXTENSION TOOLS ==');
  console.log(names.filter((n) => /extension/i.test(n)).join(', ') || '(none)');

  console.log('\n== install_extension ==');
  try {
    const r = await mcp.call('install_extension', { path: EXT_PATH }, 60000);
    console.log(mcp.text(r));
    writeFileSync(path.join(ARTIFACTS, 'install.json'), JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('install_extension FAILED:', e.message);
  }

  console.log('\n== list_extensions ==');
  try {
    const r = await mcp.call('list_extensions', {}, 60000);
    console.log(mcp.text(r));
    writeFileSync(path.join(ARTIFACTS, 'extensions.json'), JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('list_extensions FAILED:', e.message);
  }

  console.log('\n== new_page example.com ==');
  try {
    const r = await mcp.call('new_page', { url: 'https://example.com/' }, 60000);
    console.log(JSON.stringify(r).slice(0, 1200));
    writeFileSync(path.join(ARTIFACTS, 'new-page.json'), JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('new_page FAILED:', e.message);
  }

  await new Promise((r) => setTimeout(r, 2000));

  console.log('\n== list_pages ==');
  try {
    const r = await mcp.call('list_pages', {}, 60000);
    console.log(mcp.text(r).slice(0, 3000));
    writeFileSync(path.join(ARTIFACTS, 'pages.json'), JSON.stringify(r, null, 2));
  } catch (e) {
    console.log('list_pages FAILED:', e.message);
  }
} catch (e) {
  console.error('PROBE FATAL:', e);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
