@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0Install.ps1"
if errorlevel 1 echo Installation did not complete. Review the message above. No execution-policy bypass was used.
pause
