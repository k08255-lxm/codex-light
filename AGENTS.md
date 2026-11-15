# 项目发布约定

## Android APK 与更新提醒

- 只有确认 Android 代码和资源除版本信息外均无实质变化时，才使用 `--android-unchanged` 输出 `codex-light-android-VERSION.apk`；仍附 APK，但不要上传标准名别名，以免旧客户端误提示。
- 每个 Release 仍附带 APK，方便新用户下载；不要只指向旧 Release。
- v0.4.7 已包含 Android 配对行为修复，属于实质更新：恢复 v0.4.4 的局域网 HTTP 配对体验，不强绑 Wi-Fi、不绕过 VPN 策略、不额外引入 TLS。本次必须使用标准资产名称 `codex-light-0.4.7.apk`，装配时不得使用 `--android-unchanged`，应正常通知旧手机更新。此前仅版本变化的静默方案已被此决定替代。
- 以后 Android 有实质功能修复或更新时，默认恢复旧客户端兼容的 `codex-light-VERSION.apk` 资产名称。执行前核查已发布 Android 更新器的实际匹配规则，不要只依据当前源码推断旧客户端行为。
- 静默发布仅改变 APK 在 Release 中的资产名称，不篡改 APK 内容、签名或包 ID。发布前校验 APK 内部版本、原签名兼容性和哈希。
- 发布脚本、下载文档、Release 说明及版本同步测试必须与实际资产命名保持一致。不要把“本次 Android 未变”的例外永久应用到后续有实质更新的版本。
