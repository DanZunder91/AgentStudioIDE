/**
 * VillageButton — the titlebar affordance that opens the Agent Village. Mirrors
 * `<NetworkButton/>`: one store action, the destination is a singleton TAB.
 */

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
