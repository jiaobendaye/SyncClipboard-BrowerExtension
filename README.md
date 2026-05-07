# SyncClipboard Browser Extension

SyncClipboard 生态的浏览器扩展（Chrome / Firefox），通过 WebDAV 实现剪贴板跨设备手动分享。与 [SyncClipboard](https://github.com/Jeric-X/SyncClipboard) 和 Android 端完全互操作。

## 功能

- **读取剪贴板** — 一键读取系统剪贴板（文本/图片）
- **上传到服务器** — 文本短于 1KB 内联 JSON，长文本/图片/文件写入 `file/` 目录
- **从服务器下载** — 文本写入本地剪贴板，文件保存到浏览器下载目录；浏览器不接受的文件名会自动兼容化
- **选择本地文件** — 直接选择本地文件上传，不经过剪贴板
- **操作历史** — 最近上传/下载记录，可配置容量上限
- **连接管理** — 配置 WebDAV 服务器地址/用户名/密码，一键测试连接，成功自动保存
- **协议兼容** — 完整实现 [SyncClipboard WebDAV 协议](docs/protocol.md)，与桌面端和移动端互操作

## 开发进度

- [x] **WebDAV 服务** — 已实现，通过 WebDAV 服务器同步剪贴板
- [ ] **官方服务** — 待开发，接入 SyncClipboard 官方服务

## 项目结构  

```
extension/
├── manifest.json          # Chrome Extension Manifest V3
├── popup.html/css/js      # 弹出窗口 UI
├── options.html/css/js    # 设置页面
├── browser-api.js         # Chrome / Firefox API 适配层
├── webdav-client.js       # WebDAV 协议客户端（零依赖）
├── storage.js             # Chrome Storage 封装
└── storage-mock.js        # 内存/文件存储（非扩展上下文使用）
tests/
├── extension.spec.js      # Playwright E2E 测试
└── unit/
    └── webdav-client.test.js  # 协议单元测试
docs/
└── protocol.md            # 协议文档
```

## 安装使用

### Chrome

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `extension/` 目录
4. 点击扩展图标 → 设置 → 配置 WebDAV 服务器地址、用户名、密码
5. 点击「Test Connection」测试连接，成功自动保存设置
6. 回到弹出窗口，点击「Read Clipboard」读取剪贴板，点击「Upload to Server」上传

### Firefox

1. 打开 Firefox，访问 `about:debugging#/runtime/this-firefox`
2. 点击「临时载入附加组件」，选择 `extension/` 目录中的任意文件
3. 后续步骤与 Chrome 相同

## 密码存储

密码使用浏览器会话存储（`storage.session`）保存，仅在当前浏览器会话期间保留。关闭浏览器后密码自动清除，重新打开需重新输入。

Firefox 不支持 `storage.session`，密码以混淆形式存储在 `storage.local` 中，重启浏览器后仍然保留。

## 测试

```bash
# 安装 Playwright 浏览器（首次运行测试前需要执行）
npx playwright install chromium firefox

# 单元测试
npm run test:unit

# Playwright E2E 测试
npm test               # Chromium（默认）
npm run test:firefox   # Firefox
npm run test:headed    # 有头模式
```

## 发布

推送 tag 自动触发 GitHub Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 协议

详见 [docs/protocol.md](docs/protocol.md)。核心数据结构为 camelCase 的 ProfileDto JSON，通过 `/SyncClipboard.json` 读写，大文件存放在 `/file/` 目录。下载到本地时，如果浏览器拒绝原始文件名（例如点开头文件名），扩展会自动使用兼容的本地保存名。
