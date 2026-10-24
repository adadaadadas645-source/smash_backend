/**
 * What each store product gives: the same table as ShopCatalog.Items in the game
 * (Assets/Scripts/UI/Data/Shop.cs) and docs/REVENUECAT_VE_SATIN_ALMA.md. The server answers
 * with this, never with what the game sends. Minutes; -1 is for good.
 */
export interface Product {
  id: string;
  once: boolean;
  coins: number;
  heartsMin: number;
  noAdsMin: number;
  giant: number;
  bombs: number;
}

const H = 60;
const D = 24 * 60;

const p = (id: string, coins: number, heartsMin = 0, noAdsMin = 0, giant = 0, bombs = 0, once = false): Product => ({ id, once, coins, heartsMin, noAdsMin, giant, bombs });

export const PRODUCTS: Record<string, Product> = Object.fromEntries(
  [
    p('gold_1000', 1000),
    p('gold_5000', 5000),
    p('gold_10000', 10000),
    p('gold_25000', 25000),
    p('gold_50000', 50000),
    p('gold_100000', 100000),
    p('pack_starter', 1000, H, H, 1, 1),
    p('pack_gunner', 2000, 30, 0, 1, 0),
    p('pack_cannonball', 3000, 2 * H, 0, 2, 1),
    p('pack_siege', 10000, 3 * H, 0, 4, 2),
    p('pack_powder', 20000, 8 * H, 0, 6, 3),
    p('pack_fortress', 60000, 12 * H, 7 * D, 12, 6),
    p('pack_legend', 70000, 24 * H, -1, 15, 10),
    p('offer_welcome', 1000, 2 * H, H, 2, 2),
    // The two offers under "Continue?" in a level (each also adds +5 balls there, in the game only).
    p('offer_royal_deal', 0, H, 0, 2, 2),
    p('offer_special', 1000, 0, 0, 1, 0),
    p('remove_ads', 0, 0, -1, 0, 0, true),
  ].map((x) => [x.id, x]),
);

export const findProduct = (id: string): Product | null => PRODUCTS[id] ?? null;
