# Windows 本地部署器

这个目录是后续打包 EXE 的入口，目标是让同一个 Windows 程序完成两件事：

- Windows 本机部署：在当前项目目录下生成 `runtime/`、`data/`、`koishi.yml`、`start-local.bat`，不写入 C 盘系统目录。
- 远程 Linux 部署：打开 Dashboard 的部署页，填写 `root@服务器IP` 和远程目录后通过 SSH/SCP 推送更新。

## 开发运行

```powershell
cd local-deployer
npm install
npm run start
```

启动后会打开 `http://127.0.0.1:5150/dashboard/`。访问密码和管理员密码仍由 Dashboard 环境变量或数据文件管理，不在代码里硬编码。

## 打包 Windows EXE

```powershell
cd local-deployer
npm install
npm run build:win
```

输出为 `dist/` 下的 Windows portable EXE。打包会把根目录的 `packages/`、`scripts/`、`package.json`、`start.js`、`koishi.example.yml` 作为资源带入。

## 本地部署约束

- 下载包默认放到根目录 `runtime/downloads/`。
- NapCat 建议解压到 `runtime/napcat/`。
- 运行日志建议放到 `runtime/logs/`。
- OneBot WebSocket 使用 `ws://127.0.0.1:8080/onebot/v11/ws`。
- Dashboard 入口只需要访问密码；修改配置、部署、Key、密码等敏感操作仍需要管理员密码。
