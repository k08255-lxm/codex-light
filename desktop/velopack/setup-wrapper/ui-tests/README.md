# Fresh installer UI smoke test

Build `UiTests.csproj`, then run `UiTests.exe <new-output-directory>` on Windows.
The harness compiles the exact production SetupForm source. It constructs its real WinForms controls in an offscreen, transparent, taskbar-hidden window, checks brand text, consent/action state and layout, and creates DrawToBitmap PNGs. It never invokes Start, dependency checks, installer processes or registry reads. No visible blank preview is opened.

100/125/150/200 percent cases are synthetic control scaling, not proof of monitor DPI behavior. DrawToBitmap does not verify DWM, interactive UAC, clean-machine installation or dependency downloads. Dependency state coverage remains in the separate fake-host `tests/` suite.
