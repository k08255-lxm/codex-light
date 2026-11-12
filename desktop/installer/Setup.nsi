Unicode true
ManifestDPIAware true
RequestExecutionLevel user
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include WordFunc.nsh
!include StrFunc.nsh
!include x64.nsh
!include WinVer.nsh
!include dependencies.nsh
${StrStr}
${StrCase}
!ifndef PAYLOAD
!error "PAYLOAD must point to a complete framework-dependent application folder"
!endif
Name "Codex Light"
!ifdef CHECK_ONLY_BUILD
OutFile "CodexLight-PrerequisiteCheck.exe"
!else
OutFile "CodexLight-Setup.exe"
!endif
InstallDir "$LOCALAPPDATA\Programs\CodexLight"
ShowInstDetails show
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var CoreOK
Var DesktopOK
Var NodeOK
Var WebViewOK
Var Status
Var DownloadFile
Var DownloadURL
Var DownloadHash
Var HashAlgorithm
Var TrustFile
Var TrustResult

!macro FindFramework NAME RESULT TAG
 StrCpy ${RESULT} 0
 SetRegView 64
 ReadRegStr $4 HKLM "SOFTWARE\dotnet\Setup\InstalledVersions\x64" "InstallLocation"
 StrCpy $0 0
 loop_${TAG}:
 ClearErrors
 EnumRegValue $1 HKLM "SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\${NAME}" $0
 IfErrors end_${TAG}
 IntOp $0 $0 + 1
 StrCpy $2 $1 3
 StrCmp $2 "10." 0 loop_${TAG}
 IfFileExists "$4\shared\${NAME}\$1\*.dll" 0 loop_${TAG}
 StrCpy ${RESULT} 1
 end_${TAG}:
!macroend
!macro FindWebView ROOT VIEW TAG
 SetRegView ${VIEW}
 StrCpy $0 0
 web_loop_${TAG}:
 ClearErrors
 EnumRegKey $1 ${ROOT} "SOFTWARE\Microsoft\EdgeUpdate\Clients" $0
 IfErrors web_end_${TAG}
 IntOp $0 $0 + 1
 ReadRegStr $2 ${ROOT} "SOFTWARE\Microsoft\EdgeUpdate\Clients\$1" "name"
 StrCmp $2 "Microsoft Edge WebView2 Runtime" 0 web_loop_${TAG}
 ReadRegStr $2 ${ROOT} "SOFTWARE\Microsoft\EdgeUpdate\Clients\$1" "pv"
 ${VersionCompare} "$2" "142.0.0.0" $3
 StrCmp $3 2 web_loop_${TAG}
 StrCpy $WebViewOK 1
 web_end_${TAG}:
!macroend
Function DetectDependencies
 !insertmacro FindFramework "Microsoft.NETCore.App" $CoreOK core
 !insertmacro FindFramework "Microsoft.WindowsDesktop.App" $DesktopOK desktop
 StrCpy $NodeOK 0
 IfFileExists "$PROGRAMFILES64\nodejs\node.exe" 0 node_end
 nsExec::ExecToStack /TIMEOUT=5000 '"$PROGRAMFILES64\nodejs\node.exe" --version'
 Pop $0
 Pop $1
 StrCmp $0 "0" 0 node_end
 StrCpy $2 $1 1
 StrCmp $2 "v" 0 node_end
 StrCpy $1 $1 "" 1
 ${VersionCompare} "$1" "20.0.0" $2
 StrCmp $2 2 node_end
 StrCpy $NodeOK 1
 node_end:
 StrCpy $WebViewOK 0
 !insertmacro FindWebView HKLM 32 lm32
 !insertmacro FindWebView HKLM 64 lm64
 !insertmacro FindWebView HKCU 32 cu32
 SetRegView 64
 StrCpy $Status "Prerequisite check (1 = reuse installed, 0 = missing/incompatible):$\r$\n.NET 10 Core x64: $CoreOK$\r$\n.NET 10 Desktop x64: $DesktopOK$\r$\nWebView2 142+: $WebViewOK$\r$\nNode.js 20+ (Program Files): $NodeOK"
FunctionEnd
Function RequireEmptyDirectory
 IfFileExists "$INSTDIR\*" 0 empty_directory
 FindFirst $0 $1 "$INSTDIR\*"
 directory_loop:
 StrCmp $1 "" directory_done
 StrCmp $1 "." directory_next
 StrCmp $1 ".." directory_next
 FindClose $0
 MessageBox MB_ICONSTOP "Choose an empty application directory. Existing files, installations, user sessions and projects will not be overwritten."
 Abort
 directory_next:
 FindNext $0 $1
 Goto directory_loop
 directory_done:
 FindClose $0
 empty_directory:
FunctionEnd
Function .onVerifyInstDir
 Call RequireEmptyDirectory
FunctionEnd
Function .onInit
 ${IfNot} ${RunningX64}
  MessageBox MB_ICONSTOP "This installer supports Windows x64 only. No changes made."
  Quit
 ${EndIf}
 ReadEnvStr $0 "PROCESSOR_ARCHITEW6432"
 StrCmp $0 "ARM64" unsupported_arch
 ReadEnvStr $0 "PROCESSOR_ARCHITECTURE"
 StrCmp $0 "ARM64" unsupported_arch arch_ok
 unsupported_arch:
 MessageBox MB_ICONSTOP "ARM64 needs a separate supported package. No changes made."
 Quit
 arch_ok:
 ${IfNot} ${AtLeastWin10}
  MessageBox MB_ICONSTOP "Windows 10 or newer is required."
  Quit
 ${EndIf}
 SetRegView 64
 ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
 IntCmp $0 19041 build_ok unsupported_build build_ok
 unsupported_build:
 MessageBox MB_ICONSTOP "Windows 10 build 19041 or newer is required. No changes made."
 Quit
 build_ok:
 Call DetectDependencies
 !ifdef CHECK_ONLY_BUILD
 MessageBox MB_OK "$Status$\r$\nThis executable only checks prerequisites. No network or installation is possible."
 SetErrorLevel 0
 ${If} $CoreOK != 1
 ${OrIf} $DesktopOK != 1
 ${OrIf} $NodeOK != 1
 ${OrIf} $WebViewOK != 1
  SetErrorLevel 2
 ${EndIf}
 Quit
 !endif
 ${GetParameters} $0
 ClearErrors
 ${GetOptions} $0 "/CHECK" $1
 ${IfNot} ${Errors}
  MessageBox MB_OK "$Status$\r$\nRead-only mode: no network, dependency installers or app installation."
  SetErrorLevel 0
  ${If} $CoreOK != 1
  ${OrIf} $DesktopOK != 1
  ${OrIf} $NodeOK != 1
  ${OrIf} $WebViewOK != 1
   SetErrorLevel 2
  ${EndIf}
  Quit
 ${EndIf}
 MessageBox MB_OKCANCEL|MB_DEFBUTTON2 "$Status$\r$\nOnly missing prerequisites will be offered. Downloads require confirmation; official installers show normal UI/UAC. Cancel makes no installation changes." IDOK continue_init
 Quit
 continue_init:
FunctionEnd

; Standard Windows trust provider. Only the exact locked official hash is accepted
; before this check; no unsigned or merely trusted substitute can be executed.
Function VerifySignature
 System::Alloc 8192
 Pop $0
 System::Call 'kernel32::lstrcpyW(p r0,w "$TrustFile") p.r1'
 System::Call '*(i 16,p r0,p 0,p 0) p.r2'
 System::Call '*(i 48,p 0,p 0,i 2,i 1,i 1,p r2,i 1,p 0,p 0,i 0,i 0) p.r3'
 System::Call 'wintrust::WinVerifyTrust(p 0,g "{00AAC56B-CD44-11D0-8CC2-00C04FC295EE}",p r3) i.r4'
 StrCpy $TrustResult $4
 ; StateAction close at DWORD offset 28, retaining the provider state in the struct.
 IntOp $5 $3 + 28
 System::Call '*$5(i 2)'
 System::Call 'wintrust::WinVerifyTrust(p 0,g "{00AAC56B-CD44-11D0-8CC2-00C04FC295EE}",p r3) i.r4'
 System::Free $3
 System::Free $2
 System::Free $0
FunctionEnd
Function DownloadAndVerify
 IfFileExists "$WINDIR\Sysnative\curl.exe" +3
 MessageBox MB_ICONSTOP "Windows HTTPS downloader unavailable. Install prerequisites from vendor sites manually; no insecure fallback."
 Abort
 DetailPrint "Downloading pinned official dependency over HTTPS..."
 nsExec::ExecToStack /TIMEOUT=300000 '"$WINDIR\Sysnative\curl.exe" --fail --location --proto =https --proto-redir =https --connect-timeout 20 --max-time 280 --output "$DownloadFile" "$DownloadURL"'
 Pop $0
 Pop $1
 StrCmp $0 "0" download_ok
 MessageBox MB_ICONSTOP "Official HTTPS download failed. Nothing was executed."
 Abort
 download_ok:
 nsExec::ExecToStack /TIMEOUT=30000 '"$WINDIR\Sysnative\certutil.exe" -hashfile "$DownloadFile" $HashAlgorithm'
 Pop $0
 Pop $1
 StrCmp $0 "0" 0 bad_payload
 ${StrCase} $1 $1 "L"
 ${StrStr} $2 $1 $DownloadHash
 StrCmp $2 "" bad_payload
 StrCpy $TrustFile $DownloadFile
 Call VerifySignature
 StrCmp $TrustResult "0" verified
 bad_payload:
 Delete "$DownloadFile"
 MessageBox MB_ICONSTOP "Dependency hash or Windows signature verification failed. Nothing was executed. Rebuild if the vendor has rotated its bootstrapper."
 Abort
 verified:
FunctionEnd
!macro InstallDependency LABEL URL HASH ALGORITHM FILENAME MSI
 MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "${LABEL} is missing. Download its pinned official installer and open normal installation UI? Review vendor terms/UAC yourself; optional extras are not required." IDYES install_${FILENAME}
 Abort
 install_${FILENAME}:
 InitPluginsDir
 StrCpy $DownloadFile "$PLUGINSDIR\${FILENAME}"
 StrCpy $DownloadURL "${URL}"
 StrCpy $DownloadHash "${HASH}"
 StrCpy $HashAlgorithm "${ALGORITHM}"
 Call DownloadAndVerify
 !if ${MSI} = 1
  ExecShellWait "open" "$WINDIR\Sysnative\msiexec.exe" '/i "$DownloadFile"' SW_SHOWNORMAL $0
 !else
  ExecShellWait "open" "$DownloadFile" "" SW_SHOWNORMAL $0
 !endif
 Delete "$DownloadFile"
 ${If} $0 != 0
 ${AndIf} $0 != 3010
  MessageBox MB_ICONSTOP "Dependency installer canceled or failed. Existing successful installations are not rolled back."
  Abort
 ${EndIf}
!macroend
Section "Codex Light"
 Call RequireEmptyDirectory
 Call DetectDependencies
 ${If} $CoreOK != 1
 ${OrIf} $DesktopOK != 1
  !insertmacro InstallDependency ".NET 10 Windows Desktop Runtime" "${DOTNET_URL}" "${DOTNET_HASH}" "${DOTNET_ALGORITHM}" "dotnet-runtime.exe" 0
 ${EndIf}
 ${If} $WebViewOK != 1
  !insertmacro InstallDependency "Microsoft WebView2 Runtime" "${WEBVIEW_URL}" "${WEBVIEW_HASH}" "${WEBVIEW_ALGORITHM}" "webview-runtime.exe" 0
 ${EndIf}
 ${If} $NodeOK != 1
  !insertmacro InstallDependency "Node.js 24 LTS (do not select optional build tools)" "${NODE_URL}" "${NODE_HASH}" "${NODE_ALGORITHM}" "node-runtime.msi" 1
 ${EndIf}
 Call DetectDependencies
 ${If} $CoreOK != 1
 ${OrIf} $DesktopOK != 1
 ${OrIf} $NodeOK != 1
 ${OrIf} $WebViewOK != 1
  MessageBox MB_ICONSTOP "$Status$\r$\nPost-install verification failed. No app installed. A reboot or manual vendor installation may be required."
  Abort
 ${EndIf}
 SetOutPath "$INSTDIR"
 !ifndef CHECK_ONLY_BUILD
 !include payload-install.nsh
 !endif
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLight" "DisplayName" "Codex Light"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLight" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 DetailPrint "Installed. No model request or automatic application launch was performed."
SectionEnd

Section "Uninstall"
 SetRegView 64
 !ifndef CHECK_ONLY_BUILD
 !include payload-uninstall.nsh
 !endif
 Delete "$INSTDIR\Uninstall.exe"
 RMDir "$INSTDIR"
 ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLight" "UninstallString"
 StrCpy $1 '"$INSTDIR\Uninstall.exe"'
 ${If} $0 == $1
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexLight"
 ${EndIf}
 MessageBox MB_OK "Removed owned program files only. Shared .NET/Node/WebView2 and Codex configuration, sessions, projects and unknown files were retained."
SectionEnd
