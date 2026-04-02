import React from "react";
import { useTranslation } from "react-i18next";

type CommandMenuState = {
  isVisible: boolean;
  isRecording: boolean;
  canStop: boolean;
};

const initialState: CommandMenuState = {
  isVisible: true,
  isRecording: false,
  canStop: false,
};

export default function DictationCommandMenu() {
  const { t } = useTranslation();
  const [state, setState] = React.useState<CommandMenuState>(initialState);

  React.useEffect(() => {
    const dispose = window.electronAPI?.onCommandMenuState?.((nextState) => {
      setState((current) => ({
        ...current,
        ...nextState,
      }));
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        window.electronAPI?.hideCommandMenu?.();
      }
    };

    const handleWindowBlur = () => {
      window.electronAPI?.hideCommandMenu?.();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      dispose?.();
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  const handlePrimaryAction = async () => {
    if (state.canStop || state.isRecording) {
      await window.electronAPI?.commandMenuStop?.();
      return;
    }

    await window.electronAPI?.commandMenuStart?.();
  };

  const handleHide = async () => {
    await window.electronAPI?.commandMenuHidePanel?.();
  };

  return (
    <div className="dictation-command-menu-shell">
      <div className="dictation-command-menu">
        <button
          type="button"
          className="dictation-command-menu__item dictation-command-menu__item--primary"
          onClick={() => {
            void handlePrimaryAction();
          }}
        >
          {state.canStop || state.isRecording
            ? t("app.commandMenu.stopListening")
            : t("app.commandMenu.startListening")}
        </button>
        <button
          type="button"
          className="dictation-command-menu__item"
          onClick={() => {
            void handleHide();
          }}
        >
          {t("app.commandMenu.hideForNow")}
        </button>
      </div>
    </div>
  );
}
