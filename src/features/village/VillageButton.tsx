/** Titlebar button that opens the Agent Village; like `<NetworkButton/>`, a singleton tab. */

import { useAppStore } from "../../app/store";
import { VillageIcon } from "../../components/icons";

export function VillageButton(): React.JSX.Element {
  const openVillageTab = useAppStore((s) => s.layoutActions.openVillageTab);
  return (
    <button
      type="button"
      className="titlebar__icon-btn"
      data-testid="titlebar-village"
      aria-label="Agent Village"
      title="Agent Village"
      onClick={() => openVillageTab()}
    >
      <VillageIcon size={15} />
    </button>
  );
}
