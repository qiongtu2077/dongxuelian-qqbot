# 莲莲 Bot Windows 部署器 release 目录

- 正式发布附件只上传 `LianLianBOT-Deployer-v版本号.zip`，不要单独上传裸 EXE。
- zip 内包含 `LianLianBOT-Deployer/` 顶层目录、`莲莲Bot部署器.exe` 和用户 README。
- 用户需要先完整解压 zip，再运行解压目录里的 EXE；打包版会在 EXE 同级创建 `LianLianBOT/` 工作目录。
- `LianLianBOT/` 会集中保存环境、依赖、配置、下载包、NapCat 和日志。
- 构建脚本会清理并重建本目录；发布前请重新运行 `npm --prefix local-deployer run release:win`。
