import {defineConfig,globalIgnores} from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";
export default defineConfig([...next,...typescript,globalIgnores([".next/**","refs/**"]),
  {rules:{"@typescript-eslint/no-unused-vars":["warn",{argsIgnorePattern:"^_"}],"react-hooks/set-state-in-effect":"off","react-hooks/refs":"off"}}
]);
