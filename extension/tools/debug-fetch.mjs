import { McpClient, ARTIFACTS } from './mcp-client.mjs';

const EXT_NAME = 'ACBuddy';
const SITE = 'https://acbuddy.pages.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (s) => {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const b = m ? m[1].trim() : s.trim();
  try { return JSON.parse(b); } catch { return b; }
};

const mcp = new McpClient();
try {
  await mcp.start();
  const findExtId = async () => {
    const r = await mcp.call('list_extensions', {});
    for (const line of mcp.text(r).split('\n')) {
      if (line.includes(EXT_NAME)) return (line.match(/id=([a-p]{32})/) ?? [])[1] ?? null;
    }
    return null;
  };
  let extId = await findExtId();
  if (!extId) {
    await mcp.call('install_extension', { path: process.cwd() + '/.output/chrome-mv3-dev' }, 60000);
    extId = await findExtId();
  }
  await mcp.call('reload_extension', { id: extId }, 60000);
  await sleep(2000);

  const np = mcp.text(await mcp.call('new_page', { url: SITE + '/', timeout: 60000 }, 90000));
  const sitePageId = Number((np.match(/(\d+):\s*[^\n]*\[selected\]/) ?? [])[1]);
  await sleep(1500);
  await mcp.call('trigger_extension_action', { id: extId }, 60000);
  await sleep(1500);
  const lp = mcp.text(await mcp.call('list_pages', {}));
  const panelLine = (lp.match(/^\s*(\d+):\s*[^\n]*sidepanel[^\n]*$/gm) ?? [])[0];
  const panelId = Number((panelLine?.match(/^\s*(\d+):/) ?? [])[1]);
  console.log('site page:', sitePageId, 'panel:', panelId);

  const ev = async (args) =>
    unwrap(mcp.text(await mcp.call('evaluate_script', args, 60000)));

  console.log('\n[panel] manifest host_permissions:',
    JSON.stringify(await ev({ pageId: panelId, function: '() => chrome.runtime.getManifest().host_permissions' })));

  console.log('\n[panel] fetch health (no credentials):',
    JSON.stringify(await ev({ pageId: panelId, function: `async () => {
      try { const r = await fetch('${SITE}/api/health'); return { status: r.status, body: await r.json() }; }
      catch (e) { return { err: String(e) }; }
    }` })));

  console.log('\n[panel] fetch auth/me (credentials):',
    JSON.stringify(await ev({ pageId: panelId, function: `async () => {
      try { const r = await fetch('${SITE}/api/auth/me', { credentials: 'include' }); return { status: r.status, body: await r.json() }; }
      catch (e) { return { err: String(e) }; }
    }` })));

  console.log('\n[site page] fetch auth/me (credentials, web origin):',
    JSON.stringify(await ev({ pageId: sitePageId, function: `async () => {
      try {
        const r = await fetch('${SITE}/api/auth/me', { credentials: 'include' });
        return { status: r.status, aco: r.headers.get('access-control-allow-origin'), acac: r.headers.get('access-control-allow-credentials'), body: await r.json() };
      } catch (e) { return { err: String(e) }; }
    }` })));

  console.log('\n[site page] cookieStore acb_session:',
    JSON.stringify(await ev({ pageId: sitePageId, function: `async () => (await cookieStore.get('acb_session'))?.name ?? 'null'` })));
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await mcp.stop();
}
