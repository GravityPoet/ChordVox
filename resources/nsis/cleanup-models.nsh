!macro cleanOldInstalledAppResources
  ${If} $INSTDIR != ""
    IfFileExists "$INSTDIR\resources\app.asar.unpacked\*.*" 0 +3
      RMDir /r "$INSTDIR\resources\app.asar.unpacked"
      DetailPrint "Removed stale ChordVox unpacked app resources"
    IfFileExists "$INSTDIR\resources\app.asar" 0 +3
      Delete "$INSTDIR\resources\app.asar"
      DetailPrint "Removed stale ChordVox app archive"
  ${EndIf}
!macroend

!macro verifyOldUninstallAndCleanResources
  IfErrors 0 +3
    DetailPrint "Uninstall was not successful. Not able to launch uninstaller!"
    Return

  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint "Uninstall was not successful. Uninstaller error code: $R0."
    SetErrorLevel 2
    Quit
  ${EndIf}

  !insertmacro cleanOldInstalledAppResources
!macroend

!macro customUnInstallCheck
  !insertmacro verifyOldUninstallAndCleanResources
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro verifyOldUninstallAndCleanResources
!macroend

!macro customUnInstall
  StrCpy $0 "$PROFILE\.cache\chordvox\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed ChordVox cached models"
  StrCpy $1 "$PROFILE\.cache\chordvox"
  RMDir "$1"
!macroend
