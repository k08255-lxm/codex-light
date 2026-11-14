/** Consume exactly one UI layer. Modal cancel guards remain authoritative. */
export function createBackHandler({ document, layers = [], navigateBack = () => false }) {
  return () => {
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const dialog = dialogs.at(-1);
    if (dialog) {
      const EventClass = document.defaultView?.Event || Event;
      if (dialog.dispatchEvent(new EventClass('cancel', { cancelable: true }))) dialog.close();
      return true;
    }
    for (const layer of layers) {
      if (layer.isOpen()) { layer.close(); return true; }
    }
    return navigateBack() === true;
  };
}
