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
    // 力扣有内容脚本（自动记录、计时）；每个平台都有悬浮窗的内容脚本，侧边栏和悬浮窗提问时读题、读代码
    host_permissions: [
      'https://acbuddy.pages.dev/*', 'https://leetcode.cn/*', 'https://leetcode.com/*',
      'https://codefun2000.com/*', 'https://www.nowcoder.com/*', 'https://www.luogu.com.cn/*',
      'https://atcoder.jp/*', 'https://www.acwing.com/*',
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
    // 悬浮窗模式：题目页上的 iframe 装的是侧边栏同一个页面，圆钮用圆形图标
    web_accessible_resources: [{
      resources: ['sidepanel.html', 'icons/bubble.png'],
      matches: [
        'https://leetcode.cn/*', 'https://leetcode.com/*', 'https://codefun2000.com/*', 'https://www.nowcoder.com/*',
        'https://www.luogu.com.cn/*', 'https://atcoder.jp/*', 'https://www.acwing.com/*',
      ],
    }],
  },
});
