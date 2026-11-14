import {defineConfig,devices} from "@playwright/test";

const fixture={
  MONEYLENS_LEGAL_OPERATOR_NAME:"Automation fixture (not a real operator)",
  MONEYLENS_LEGAL_CONTACT_EMAIL:"legal-fixture@example.invalid",
  MONEYLENS_LEGAL_OPERATOR_LOCATION:"Automation fixture location",
};
export default defineConfig({
  testDir:"tests/browser",testMatch:"legal.spec.ts",fullyParallel:false,
  use:{...devices["Desktop Chrome"],channel:process.env.CI?undefined:"chrome",serviceWorkers:"block"},
  projects:[
    {name:"legal-unconfigured",use:{baseURL:"http://127.0.0.1:31331"}},
    {name:"legal-configured",use:{baseURL:"http://127.0.0.1:31332"}},
  ],
  webServer:[false,true].map(configured=>{
    const port=configured?31332:31331;
    return {command:`npm run start -- --port ${port}`,url:`http://127.0.0.1:${port}/privacy`,reuseExistingServer:false,timeout:60000,
      env:{MONEYLENS_API_URL:"http://127.0.0.1:9",MONEYLENS_LEGAL_TEST_PRIVATE_SENTINEL:"PRIVATE_LEGAL_TEST_MARKER_DO_NOT_DISCLOSE",
        ...Object.fromEntries(Object.entries(fixture).map(([key,value])=>[key,configured?value:""]))}};
  }),
});
