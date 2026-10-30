!include "nsDialogs.nsh"

!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define MUI_FINISHPAGE_TEXT "DDTrans is installed. If the bundled VB-CABLE driver was newly installed, restart Windows later before using it."

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom DDTransAudioInfoCreate
!macroend

!macro customFinishPage
  !insertmacro MUI_PAGE_FINISH
!macroend

!ifndef BUILD_UNINSTALLER
  Function DDTransAudioInfoCreate
    nsDialogs::Create 1018
    Pop $0
    StrCmp $0 error ddtrans_audio_info_failed

    ${NSD_CreateLabel} 0u 0u 100% 74u "DDTrans bundles the VB-CABLE virtual audio driver from VB-Audio Software. VB-CABLE is Donationware. No separate download is required. Provider support, Donationware information, and the original license are included after installation in resources\virtual-audio\vendor-license.html and THIRD-PARTY-NOTICES.txt."
    Pop $0
    nsDialogs::Show
    Return

    ddtrans_audio_info_failed:
      Abort
  FunctionEnd
!endif

!macro customInstall
  DetailPrint "Installing bundled VB-CABLE virtual audio driver..."
  nsExec::ExecToLog '"$INSTDIR\resources\virtual-audio\ddtrans-audio-device.exe" install "$INSTDIR\resources\virtual-audio\vendor"'
  Pop $0
  DetailPrint "DDTrans audio helper exited with code $0."
  StrCmp $0 "error" ddtrans_audio_install_exec_error
  IntCmp $0 0 ddtrans_audio_install_done
  IntCmp $0 3010 ddtrans_audio_install_reboot ddtrans_audio_install_failed ddtrans_audio_install_failed

  ddtrans_audio_install_reboot:
    SetErrorLevel 3010
    IfSilent ddtrans_audio_install_done
    SetRebootFlag true
    DetailPrint "The virtual audio driver was installed. Windows must restart before it is available."
    Goto ddtrans_audio_install_done

  ddtrans_audio_install_exec_error:
    StrCpy $0 1

  ddtrans_audio_install_failed:
    DetailPrint "The bundled virtual audio driver could not be installed."
    DetailPrint "Installation stopped because the DDTrans audio helper failed with code $0."
    IfSilent ddtrans_audio_install_abort
    MessageBox MB_OK|MB_ICONSTOP "DDTrans setup could not install the bundled VB-CABLE virtual audio driver (helper exit code $0). Setup is aborted. Review the installer log and run setup again as an administrator."

  ddtrans_audio_install_abort:
    SetErrorLevel $0
    Abort

  ddtrans_audio_install_done:
!macroend

!macro customUnInstall
  DetailPrint "Removing any pending DDTrans virtual-audio alias task..."
  nsExec::ExecToLog '"$INSTDIR\resources\virtual-audio\ddtrans-audio-device.exe" cleanup-task'
  Pop $0
  DetailPrint "DDTrans virtual-audio alias task cleanup exited with code $0."
!macroend
