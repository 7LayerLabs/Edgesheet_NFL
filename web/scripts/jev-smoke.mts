// Quick live check of src/lib/jev.ts. Run: npx tsx scripts/jev-smoke.mts
import { askJev, noulQ, scoreQ, choiceQ, jevAvailable, lastJevError, nouls } from "../src/lib/jev";
console.log("available", jevAvailable());
const t0 = Date.now();
const a = await askJev({ post: "Sources: Georgia QB Gunner Stockton is questionable for Saturday with an ankle injury suffered in practice.", player: { name: "Gunner Stockton", team: "Georgia", position: "QB" } }, {
  injury: noulQ("Does `post` report an injury or availability news about `player`?"),
  praise: noulQ("Does `post` praise `player`'s play?"),
  drama: scoreQ("How dramatic is this news for a fan?", ["routine", "notable", "season changing"]),
  kind: choiceQ("What kind of post is `post`?", { injury: "injury or availability", praise: "praise", other: null }),
}, { purpose: "smoke" });
console.log(Date.now() - t0, "ms", JSON.stringify(a), lastJevError);
const n = await nouls("Ohio State's defense looked unstoppable.", { praise: "Is this praise?" }, { purpose: "smoke" });
console.log(n);
