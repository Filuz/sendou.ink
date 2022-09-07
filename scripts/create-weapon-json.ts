import weapons from "./dicts/WeaponInfoMain.json";
import fs from "node:fs";
import path from "node:path";
import invariant from "tiny-invariant";
import { LANG_JSONS_TO_CREATE, loadLangDicts } from "./utils";

const INTERNAL_NAMES_TO_IGNORE: readonly string[] = ["Free"] as const;
const OUTPUT_DIR_PATH = path.join(__dirname, "output");
const LEAN_WEAPON_CATEGORY_KEY = "CommonMsg/Weapon/WeaponName_Main";

async function main() {
  const result: Array<{
    id: number;
    internalName: string;
    translations: Array<{ language: string; name: string }>;
  }> = [];
  const langDicts = await loadLangDicts();

  for (const weapon of weapons) {
    if (
      weapon.Type === "Coop" ||
      INTERNAL_NAMES_TO_IGNORE.includes(weapon.__RowId)
    ) {
      continue;
    }

    result.push({
      id: weapon.Id,
      internalName: weapon.__RowId,
      translations: langDicts.map(([langCode, translations]) => {
        const name = translations[LEAN_WEAPON_CATEGORY_KEY]?.[weapon.__RowId];
        invariant(name);

        return {
          language: langCode,
          name,
        };
      }),
    });
  }

  result.sort((a, b) => a.id - b.id);

  const weaponIds = result.map((w) => w.id);

  fs.writeFileSync(
    path.join(OUTPUT_DIR_PATH, "weapons.json"),
    JSON.stringify(result, null, 2)
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR_PATH, "weapon-ids.json"),
    JSON.stringify(weaponIds, null, 2)
  );

  for (const langCode of LANG_JSONS_TO_CREATE) {
    const translationsMap = Object.fromEntries(
      result.map((w) => {
        const translation = w.translations.find(
          (t) => t.language === langCode
        )?.name;
        invariant(
          translation,
          `No translation for ${w.internalName} in ${langCode}`
        );

        return [w.id, translation];
      })
    );

    fs.writeFileSync(
      path.join(
        __dirname,
        "..",
        "public",
        "locales",
        langCode.slice(2),
        `weapons.json`
      ),
      JSON.stringify(translationsMap, null, 2) + "\n"
    );
  }
}

void main();