# My Tampermonkey Scripts

## Discourse 用户等级缓存

安装地址：

https://raw.githubusercontent.com/RSJWY/MyTampermonkeyScript/main/discourse-user-level-cache.user.js

功能：

- 支持多个 Discourse 站点，默认启用 `idcflare.com`。
- 在帖子页按单条帖子手动获取作者等级。
- 已缓存用户支持手动刷新。
- 打开用户主页时，尽量从页面已有数据缓存用户等级，不主动请求用户接口。
- 打开首页、最新页、分类页等列表页时，缓存页面已有的用户基础信息，并在帖子标题附近显示已缓存的发帖者等级。
- 缓存按站点和用户名隔离，默认保留 30 天。
- 只有点击“获取等级”或“刷新”时才请求 `/posts/{postId}.json`。

站点配置：

- 在目标站点点击 Tampermonkey 菜单里的 `Discourse 等级：启用当前站点`。
- 或使用 `Discourse 等级：管理站点` 批量配置域名。
- 支持 `forum.example.com` 和 `*.example.com`。

自动更新：

脚本头部包含 `@updateURL` 和 `@downloadURL`，Tampermonkey 会从本仓库的 raw 文件地址检查更新。发布新版本时请递增 userscript 头部的 `@version`。
