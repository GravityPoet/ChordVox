!macro customUnInstall
  StrCpy $0 "$PROFILE\.cache\ariakey\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed AriaKey cached models"
  StrCpy $1 "$PROFILE\.cache\ariakey"
  RMDir "$1"
!macroend
