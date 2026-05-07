# SyncClipboard WebDAV Protocol

本扩展实现了 SyncClipboard 生态的 WebDAV 剪贴板同步协议，与 Reference C#（桌面端）和 TypeScript（移动端）客户端完全互操作。

## 服务端布局

```
{WebDAV-Root}/
├── SyncClipboard.json    # 当前剪贴板 profile（协议核心）
└── file/                  # 大文件 / 二进制数据
    ├── wx_camera_xxx.jpg
    ├── syncclipboard-20260507T113000Z-image.png
    └── ...
```

- `SyncClipboard.json` 只有一份，每次上传覆盖前次内容。
- 文本短于 `TEXT_INLINE_MAX_BYTES`（1024 字节）时内联在 JSON 中，不写 `file/` 目录。
- 文本超长、图片、文件等二进制内容写入 `file/` 目录，profile 中通过 `dataName` 引用。

## ProfileDto — 核心数据结构

所有字段使用 **camelCase**（与 Reference 客户端一致，C# 侧通过 `System.Text.Json` 的 `camelCase` 命名策略序列化）。

```jsonc
{
  "type": "Text",           // "Text" | "Image" | "File" | "Group"
  "hash": "B780770E...",    // SHA-256 大写十六进制，64 字符
  "text": "早市的烧白也在这", // Text: 完整内容或前缀；文件: 文件名
  "hasData": false,          // true 时 dataName 必须存在
  "dataName": null,          // hasData=false 时不出现此字段
  "size": 8                  // Text 为完整字符串长度；文件为字节数
}
```

### 字段规则

| 字段 | 类型 | 内联文本 | 文件型 | 说明 |
|------|------|---------|--------|------|
| `type` | string | `"Text"` | `"Image"` / `"File"` | 内容类型 |
| `hash` | string | `SHA256(text)` | Text 长文本仍为 `SHA256(fullText)`；Image/File 为 `SHA256(fileName + "|" + SHA256(blob))` | 64 位大写十六进制 |
| `text` | string | 内容本身 | Text 长文本为完整内容前缀；Image/File 为文件名 | 预览/展示用，无前缀 |
| `hasData` | boolean | `false` | `true` | 标记是否有文件数据 |
| `dataName` | string? | 不出现 | 文件名 | `hasData=true` 时必填 |
| `size` | number | `text.length` | Text 长文本为完整字符串长度；文件为字节数 | 内容长度 |

### 内联文本示例

```json
{
  "type": "Text",
  "hash": "B780770E65416A4E8DBCD4CCDD86BBBF1322F682256C4CCF443F0AB0FF5AE770",
  "text": "早市的烧白也在这",
  "hasData": false,
  "size": 8
}
```

- `dataName` 字段 **不出现**（不是 `null`）。

### 长文本示例（Text + hasData=true）

```json
{
  "type": "Text",
  "hash": "B780770E65416A4E8DBCD4CCDD86BBBF1322F682256C4CCF443F0AB0FF5AE770",
  "text": "这是一段超长文本的开头……",
  "hasData": true,
  "dataName": "syncclipboard-20260507T113000Z-text.txt",
  "size": 4096
}
```

- `text` 保存完整文本的前缀，不追加 `"..."`。
- `dataName` 指向 UTF-8 编码的完整文本文件。
- `hash` 仍然是**完整文本内容**的 SHA-256，而不是文件型的 `fileName|contentHash` 规则。

### 文件型示例（图片/文件）

```json
{
  "type": "Image",
  "hash": "D87E578199230A93F6D81D2EC6D01CC909ADC5FEF5C27C7C83EBAED92DDA5DA7",
  "text": "wx_camera_1778119122004.jpg",
  "hasData": true,
  "dataName": "wx_camera_1778119122004.jpg",
  "size": 1268354
}
```

- `text` 就是文件名，**不加** `[Image]` / `[File]` 等前缀。
- `dataName` 与 `text` 相同（都是文件名）。

## Hash 算法

### 内容哈希 `computeHash(data)`

```
SHA256(blob bytes) → 大写十六进制字符串
```

- 浏览器端：`crypto.subtle.digest('SHA-256', arrayBuffer)`
- C# 端：`SHA256.HashData()` + `Convert.ToHexString()`
- 移动端：同上，最终 `.toUpperCase()`

### Profile 哈希 `computeProfileHash(fileName, blob)`

仅用于 **文件型内容**（Text 超长、Image、File）：

```
profileHash = SHA256(fileName + "|" + SHA256(blob).toUpperCase())
```

即：文件名 + 竖线 + 内容哈希（大写），再哈希一次。这是服务端用于去重/校验的规则，三端实现完全一致。

## WebDAV 操作

### 连接测试

```
PROPFIND {baseUrl}/
Authorization: Basic base64(username:password)
```

- 200 或 207 → 连接成功
- 401 → 认证失败（用户名或密码错误）
- 网络错误 → 服务器不可达

浏览器扩展使用 `XMLHttpRequest`（非 `fetch`），通过 `xhr.open(method, url, true, username, password)` 传入凭证，避免 Chrome 在 401 响应时弹出原生认证对话框。

### 读取 Profile

```
GET {baseUrl}/SyncClipboard.json
```
- 200 → 解析 JSON 返回 ProfileDto
- 404 → 返回空白 Text profile（`{type:"Text", hash:"", text:"", hasData:false, size:0}`）

### 上传 Profile

```
MKCOL {baseUrl}/         (确保根目录存在，405/409 视为成功)
PUT {baseUrl}/SyncClipboard.json
Content-Type: application/json
Body: JSON.stringify(profileDto)
```

### 上传文件数据

```
MKCOL {baseUrl}/file/    (确保 file 目录存在，405/409 视为成功)
PUT {baseUrl}/file/{encodeURIComponent(fileName)}
Content-Type: application/octet-stream
Body: Blob
```

### 下载文件数据

```
GET {baseUrl}/file/{encodeURIComponent(fileName)}
```
- 浏览器扩展：直接 URL + Auth Header 传给 `chrome.downloads.download`
- 普通页面：fetch → Blob → 模拟下载

## 认证

HTTP Basic Auth：
```
Authorization: Basic base64(username + ":" + password)
```

无用户名密码时不发送 Authorization 头。

## 文件名生成规则

未指定文件名时自动生成：

| 类型 | 格式 | 示例 |
|------|------|------|
| Text | `syncclipboard-{ISO时间戳}-text.txt` | `syncclipboard-20260507T113000Z-text.txt` |
| Image | `syncclipboard-{ISO时间戳}-image.{ext}` | `syncclipboard-20260507T113000Z-image.png` |
| File | `syncclipboard-{ISO时间戳}-file.bin` | `syncclipboard-20260507T113000Z-file.bin` |

时间戳格式：`YYYYMMDDTHHmmssZ`（ISO 8601 简化，去掉了 `-`、`:` 和毫秒）。

图片扩展名从 MIME 类型推导：`image/png`→`.png`、`image/jpeg`→`.jpg`、`image/webp`→`.webp`、`image/gif`→`.gif`，未知类型默认为 `.png`。

## 客户端兼容性

| 实现 | 语言 | 协议版本 |
|------|------|---------|
| Reference Desktop | C# | ProfileDto PascalCase via JSON property names |
| Reference Mobile | TypeScript | ProfileDto camelCase |
| **Browser Extension** | **JavaScript** | **ProfileDto camelCase（本扩展）** |

C# 客户端通过 `[JsonPropertyName]` 或 `JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase` 与 camelCase 兼容。
