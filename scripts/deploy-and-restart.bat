@echo off
setlocal

echo [已停用] 此脚本会绕过发布清单、预览、发布锁、基线复核和自动回滚。
echo 远程生产更新请打开 Dashboard 的“部署”页，先生成预览，再确认执行不可变发布。
echo Dashboard 发布物已经包含日报插件，不再支持直传单个文件后远程重启。
exit /b 2
