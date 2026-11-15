import {describe,it,expect} from "vitest";
import {speechText,preferredVoice} from "./speech-text";
import {money} from "./format";

describe("read-aloud text",()=>{
 it("speaks euro amounts naturally in every language",()=>{
  const amount=money(139020),small=money(3097),round=money(20000),negative=money(-3097);
  expect(speechText(`Rent ${amount}, taxis ${small}, purchase ${round}`,"en")).toBe("Rent 1390 euros 20 cents, taxis 30 euros 97 cents, purchase 200 euros");
  expect(speechText(small,"fi")).toBe("30 euroa 97 senttiä");
  expect(speechText(small,"et")).toBe("30 eurot 97 senti");
  expect(speechText(small,"de")).toBe("30 Euro und 97 Cent");
  expect(speechText(small,"sv")).toBe("30 euro och 97 cent");
  expect(speechText(negative,"en")).toBe("minus 30 euros 97 cents");
 });
 it("speaks dates and ranges instead of digits and dashes",()=>{
  expect(speechText("Based on records from 1.9.2026–30.9.2026 · partial data","en")).toBe("Based on records from 1 September 2026 to 30 September 2026, partial data");
  expect(speechText("Payday 15.10.2026","de")).toBe("Payday 15. Oktober 2026");
  expect(speechText("31.2.2026","en")).toBe("31.2.2026");
 });
 it("prefers the exact regional, natural local voice",()=>{
  const voices=[{lang:"en-US",name:"Microsoft David",localService:true},{lang:"en-GB",name:"Google UK English",localService:false},{lang:"en-US",name:"Microsoft Aria Online (Natural)",localService:true},{lang:"fi-FI",name:"Satu",localService:true}];
  expect(preferredVoice(voices,"en","en-US",true)?.name).toBe("Microsoft Aria Online (Natural)");
  expect(preferredVoice(voices,"en","en-GB",false)?.name).toBe("Google UK English");
  expect(preferredVoice(voices,"en","en-GB",true)?.name).toBe("Microsoft Aria Online (Natural)");
  expect(preferredVoice(voices,"de","de-DE",true)).toBeUndefined();
 });
});
