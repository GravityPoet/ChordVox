!macro customUnInstall
  StrCpy $0 "$PROFILE\.cache\chordvox\models"
  IfFileExists "$0\*.*" 0 +3
    RMDir /r "$0"
    DetailPrint "Removed ChordVox cached models"
  StrCpy $1 "$PROFILE\.cache\chordvox"
  RMDir "$1"
!macroend
