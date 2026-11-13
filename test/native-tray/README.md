# 原生托盘生命周期测试

在 Windows 和 .NET 10 SDK 环境运行：

```powershell
dotnet build test/native-tray/Test.csproj -c Release
dotnet test/native-tray/bin/Release/net10.0-windows/Test.dll
```

测试直接编译桌面宿主源码，使用透明、禁用且不显示任务栏项的测试窗口。它移除 `Shown` 的后台启动委托，并隔离窗口状态文件；不启动 Node 或 WebView，不查找或关闭用户的应用进程。测试期间会短暂创建实际托盘图标，完成后释放。

Restart Manager 集成用例启动绝对路径的专用 GUI 测试宿主 `Test.exe`，核对该自有子进程的 PID、创建时间、路径和 Windows 会话，然后仅向它调用正式安装器适配器的 `RmShutdown(flags=0)`。子进程实际转入托盘，验证正常退出后窗口和托盘资源已释放，并确认没有触发 20 秒自关闭 watchdog。测试不会使用强杀兜底；失败时等待该 fixture 自行关闭。部分受限沙箱无法创建 Restart Manager 会话，可能报 `ERROR_WRITE_FAULT (29)`；这种情况需要在允许原生 RM API 的环境运行，不能视为测试通过。

退出协议以运行时实测为准：当前 Windows/.NET 10 环境下，RM 使 WinForms 消息循环结束并释放主窗口；该窗口未记录到 `WM_QUERYENDSESSION` / `WM_ENDSESSION`，因此不强制断言 `WindowSessionEnd.Confirmed=true`。通过条件为 RM 调用成功、自有进程正常退出和真实资源清理。

覆盖加载时托盘可用、图标复用、隐藏和最小化后的恢复、失败时恢复窗口、失败状态禁止隐藏、托盘退出和资源释放，以及真实 Restart Manager 关闭自有托盘窗口。它不验证 Explorer 崩溃重启、通知区域可见性设置、真实后台任务停止或已安装旧版应用。
