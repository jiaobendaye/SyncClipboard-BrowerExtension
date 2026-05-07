# SyncClipboard Browser Extension

SyncClipboard 生态的 Chrome 浏览器扩展，通过 WebDAV 实现剪贴板跨设备手动分享。与 [SyncClipboard](https://github.com/Jeric-X/SyncClipboard) 和 Android 端完全互操作。

## 功能

- **读取剪贴板** — 一键读取系统剪贴板（文本/图片）
- **上传到服务器** — 文本短于 1KB 内联 JSON，长文本/图片/文件写入 `file/` 目录
- **从服务器下载** — 文本写入本地剪贴板，文件保存到浏览器下载目录
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
├── webdav-client.js       # WebDAV 协议客户端（零依赖）
├── storage.js             # Chrome Storage 封装
└── storage-mock.js        # 内存/文件存储（非扩展上下文使用）
tests/
├── extension.spec.js      # Playwright E2E 测试
└── unit/
    └── webdav-client.test.js  # 协议单元测试
docs/
└── protocol.md            # 协议文档
.github/workflows/
├── ci.yml                 # CI：单元测试 + 打包
└── release.yml            # 发布：打 tag 自动创建 GitHub Release
```

## 安装使用

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `extension/` 目录
4. 点击扩展图标 → 设置 → 配置 WebDAV 服务器地址、用户名、密码
5. 点击「Test Connection」测试连接，成功自动保存设置
6. 回到弹出窗口，点击「Read Clipboard」读取剪贴板，点击「Upload to Server」上传

## 密码存储

密码使用 `chrome.storage.session` 存储，仅在当前浏览器会话期间保留。关闭浏览器后密码自动清除，重新打开需重新输入。服务器地址和用户名使用 `chrome.storage.local` 持久存储。

## 测试

```bash
# 单元测试
npm run test:unit

# Playwright E2E 测试
npm run test
npm run test:headed    # 有头模式
```

## 发布

推送 tag 自动触发 GitHub Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 协议

详见 [docs/protocol.md](docs/protocol.md)。核心数据结构为 camelCase 的 ProfileDto JSON，通过 `/SyncClipboard.json` 读写，大文件存放在 `/file/` 目录。
