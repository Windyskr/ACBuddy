import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: { disabled: true },
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'zh_CN',
    homepage_url: 'https://acbuddy.pages.dev',
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'storage', 'scripting'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    // 力扣有内容脚本（自动记录、计时）；codefun2000、牛客只在打开侧边栏提问时读题、读代码
    host_permissions: [
      'https://acbuddy.pages.dev/*', 'https://leetcode.cn/*', 'https://leetcode.com/*',
      'https://codefun2000.com/*', 'https://www.nowcoder.com/*',
    ],
    icons: {
      16: '/icons/icon16.png',
      32: '/icons/icon32.png',
      48: '/icons/icon48.png',
      128: '/icons/icon128.png',
    },
    action: {},
    side_panel: {
      default_path: '/sidepanel.html',
    },
  },
});
