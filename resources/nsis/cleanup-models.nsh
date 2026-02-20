!macro customUnInstall
  StrCpy $0 "$PROFILE\.cache\moonlitvoice\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed MoonlitVoice cached models"
  StrCpy $1 "$PROFILE\.cache\moonlitvoice"
  RMDir "$1"
!macroend
