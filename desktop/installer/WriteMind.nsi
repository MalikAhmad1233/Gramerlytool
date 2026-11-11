; WriteMind AI — Windows installer (NSIS 3, Modern UI 2).
;
; Per-user install: no administrator rights, no UAC prompt. Installs to
; %LOCALAPPDATA%\Programs\WriteMind, adds Start menu (and optional desktop) shortcuts, registers an
; uninstaller under "Apps & features", and can copy the Chrome extension next to the app.
;
; Build (Windows or Linux):  makensis -DAPP_EXE=<WriteMind.exe> -DEXT_DIR=<chrome-mv3 folder> \
;                                     -DVERSION=1.1.0 -DOUTFILE=<WriteMind-Setup.exe> WriteMind.nsi
; See build-installer.sh.

Unicode true
SetCompressor /SOLID lzma
ManifestDPIAware true

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "1.1.0"
!endif
!ifndef APP_EXE
  !error "Pass -DAPP_EXE=path\to\WriteMind.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "WriteMind-Setup-${VERSION}.exe"
!endif

!define APP_NAME "WriteMind AI"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\WriteMind"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\WriteMind"
InstallDirRegKey HKCU "Software\WriteMind" "InstallDir"
RequestExecutionLevel user
BrandingText "${APP_NAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "WriteMind"
VIAddVersionKey "LegalCopyright" "WriteMind"

; ------------------------------------------------------------------ look & feel
!define MUI_ICON "..\src\WriteMind.Desktop\Assets\writemind.ico"
!define MUI_UNICON "..\src\WriteMind.Desktop\Assets\writemind.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "header.bmp"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC

!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "WriteMind checks your spelling and grammar as you type in Word, Outlook, Notepad, WhatsApp and more — and suggests clearer, more professional wording.$\r$\n$\r$\n•  It never changes your text on its own: you approve every correction.$\r$\n•  It works offline, with no account and no sign-in.$\r$\n•  It skips passwords and other private fields.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "WriteMind is ready"
!define MUI_FINISHPAGE_TEXT "WriteMind runs quietly in the system tray (bottom-right, near the clock).$\r$\n$\r$\nStart typing in Word, Outlook, Notepad or WhatsApp and click an underlined word to see a suggestion. Press Ctrl+Alt+W at any time to open the writing assistant."
!define MUI_FINISHPAGE_RUN "$INSTDIR\WriteMind.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start WriteMind now"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Show me how to add WriteMind to Google Chrome"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION OpenChromeGuide
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------------ helpers
!macro CloseWriteMind
  ; Close a running copy so its files can be replaced (it keeps no unsaved state).
  nsExec::Exec 'taskkill /IM WriteMind.exe'
  Sleep 800
  nsExec::Exec 'taskkill /F /IM WriteMind.exe'
  Sleep 300
!macroend

Function OpenChromeGuide
  ${If} ${FileExists} "$INSTDIR\Chrome extension\Install in Chrome.html"
    ExecShell "open" "$INSTDIR\Chrome extension\Install in Chrome.html"
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------ sections
Section "WriteMind AI (required)" SecApp
  SectionIn RO
  !insertmacro CloseWriteMind
  SetOutPath "$INSTDIR"
  File "/oname=WriteMind.exe" "${APP_EXE}"
  WriteUninstaller "$INSTDIR\Uninstall WriteMind.exe"

  CreateDirectory "$SMPROGRAMS\WriteMind AI"
  CreateShortcut "$SMPROGRAMS\WriteMind AI\WriteMind AI.lnk" "$INSTDIR\WriteMind.exe" "" "$INSTDIR\WriteMind.exe" 0 SW_SHOWNORMAL "" "Check spelling and grammar everywhere you write"
  CreateShortcut "$SMPROGRAMS\WriteMind AI\Uninstall WriteMind.lnk" "$INSTDIR\Uninstall WriteMind.exe"

  WriteRegStr HKCU "Software\WriteMind" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "WriteMind"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\WriteMind.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall WriteMind.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall WriteMind.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\WriteMind AI.lnk" "$INSTDIR\WriteMind.exe" "" "$INSTDIR\WriteMind.exe" 0 SW_SHOWNORMAL "" "Check spelling and grammar everywhere you write"
SectionEnd

!ifdef EXT_DIR
Section "Chrome extension (Gmail, WhatsApp Web, LinkedIn…)" SecChrome
  SetOutPath "$INSTDIR\Chrome extension"
  File /r "${EXT_DIR}\*.*"
  File "/oname=Install in Chrome.html" "chrome-setup.html"
SectionEnd
!endif

Section "-Finish"
  ; Size shown in "Apps & features".
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} "The WriteMind app for Word, Outlook, Notepad, WhatsApp and other Windows apps."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Put a WriteMind icon on your desktop."
!ifdef EXT_DIR
  !insertmacro MUI_DESCRIPTION_TEXT ${SecChrome} "Copy the WriteMind Chrome extension to your computer, with step-by-step instructions to add it to Chrome."
!endif
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ------------------------------------------------------------------ uninstall
Section "Uninstall"
  !insertmacro CloseWriteMind
  Delete "$INSTDIR\WriteMind.exe"
  Delete "$INSTDIR\Uninstall WriteMind.exe"
  RMDir /r "$INSTDIR\Chrome extension"
  RMDir "$INSTDIR"

  Delete "$DESKTOP\WriteMind AI.lnk"
  RMDir /r "$SMPROGRAMS\WriteMind AI"

  DeleteRegValue HKCU "${RUN_KEY}" "WriteMind AI"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\WriteMind"

  ; Settings and the personal dictionary live in %APPDATA%\WriteMind. Keep them unless asked.
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove your WriteMind settings and personal dictionary?" /SD IDNO IDNO done
    RMDir /r "$APPDATA\WriteMind"
  done:
SectionEnd
