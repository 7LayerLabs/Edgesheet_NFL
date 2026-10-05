import { getSlate } from "@/lib/slate";
import { WatchlistClient } from "./WatchlistClient";
import { cardGame } from "@/lib/card";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const slate = await getSlate();
  return <WatchlistClient games={slate.weekGames.map(cardGame)} />;
}
