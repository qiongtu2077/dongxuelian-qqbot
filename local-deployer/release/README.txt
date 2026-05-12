# 莲莲 Bot Windows 部署器 release 目录

- 正式发布附件只上传 `LianLianBOT-Deployer-v版本号.zip`，不要单独上传裸 EXE。
- zip 内包含 `LianLianBOT-Deployer/` 顶层目录、`莲莲Bot部署器.exe` 和用户 README。
- 用户需要先完整解压 zip，再运行解压目录里的 EXE；不要在压缩包预览窗口中直接运行。
- 打包版只会在用户点击安装、生成配置或一键部署等写入动作时创建 `LianLianBOT/` 工作目录；单纯启动 EXE 不会生成密码重置令牌。
- `LianLianBOT/` 会集中保存环境、依赖、配置、下载包、NapCat、图集和日志。
- v1.1.4 起，Node/npm、NapCat 自动安装和一键卸载会重试清理半成品目录；莲莲图集上传不需要管理员密码，图片预览可由浏览器直接读取。
- 构建脚本会清理并重建本目录；发布前请重新运行 `npm --prefix local-deployer run release:win`。
