@echo off
setlocal

echo [已停用] 此脚本会绕过发布清单、预览、发布锁、基线复核和自动回滚。
echo 远程生产更新请打开 Dashboard 的“部署”页，先生成预览，再确认执行不可变发布。
echo 如需本地开发构建，请在 packages\koishi-plugin-dashboard\frontend 运行 npm run build。
exit /b 2
