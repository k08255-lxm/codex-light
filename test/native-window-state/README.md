# 原生窗口状态测试

在 Windows 上从仓库根目录执行，需要 .NET 10 SDK 和 Windows Desktop Runtime：

```powershell
dotnet build test/native-window-state/Test.csproj -c Release
dotnet test/native-window-state/bin/Release/net10.0-windows/Test.dll
```

项目设置 `UseAppHost=false`，通过系统 `dotnet.exe` 运行测试 DLL。测试不会启动主程序、Node 后台或 WebView2。

测试覆盖窗口位置与状态、DPI/工作区换算、显示器断开、损坏配置、原子保存，以及 `WM_QUERYENDSESSION` 和 `WM_ENDSESSION` 的资源释放语义。测试文件写入测试输出目录的随机子目录，结束后清理，不读取真实用户的窗口状态文件。

原生消息用例创建不显示的 HWND，检查非客户区绘制、主题、窗口几何和命中结果，并断言前台窗口保持不变。拒写用例会产生预期的 `Window state not saved` 诊断。

这些是程序状态与消息处理测试，不覆盖实际注销/关机、截图工具后的桌面合成、可见拖动或物理跨屏 DPI 行为。
