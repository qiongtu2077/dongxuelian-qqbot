# 莲莲 Bot Windows 部署器 release 目录

- 推荐新用户下载便携版：`LianLianBOT-Deployer-Portable-v1.1.7.zip`。完整解压后运行里面的 `莲莲Bot部署器.exe`，不会安装系统快捷方式。
- 需要开始菜单或桌面快捷方式时下载安装版：`LianLianBOT-Deployer-Setup-v1.1.7.exe`。安装器会显示安装路径，运行数据不放在安装目录。
- 便携版工作目录：EXE 同级的 `LianLianBOT/`。
- 安装版工作目录：`%USERPROFILE%\Documents\LianLianBOT`，文档目录不可写时回退到 Electron 用户数据目录。
- 程序资源源码目录位于应用自身的 `resources\app`，这是只读资源；Node、NapCat、配置、日志和图集都在工作目录。
- 启动失败时，部署器弹窗会显示日志路径；也可以在部署页查看“程序目录 / 资源目录 / 工作目录 / 日志目录”。
- 不要把安装版 setup exe 重命名成普通运行 exe，也不要在压缩包预览窗口中直接双击便携版。
- 构建脚本会清理并重建本目录；发布前请重新运行 `npm --prefix local-deployer run release:win`。
