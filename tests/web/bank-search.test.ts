import test from "node:test";
import assert from "node:assert/strict";
import {matchesBank,normalizeBankName} from "../../apps/web/lib/bank-search.ts";

test("bank search folds accents, punctuation, case and spacing",()=>{
 for(const query of ["s pankki","S.PANKKI","s - pankki","spankki","S Bank"])assert(matchesBank({name:"S-Pankki",country:"FI"},query));
 assert(matchesBank({name:"Järve Demo Bank",country:"EE"},"JARVE DEMO"));
 assert(matchesBank({name:"Coop Pank",country:"EE"},"coop bank"));
 assert(matchesBank({name:"LHV Pank",country:"EE"},"LHV Bank"));
 assert(matchesBank({name:"Wise",country:"EE"},"Wise Personal"));
 assert(!matchesBank({name:"Other fixture",country:"FI"},"OP"));
 assert(matchesBank({name:"Provider exact fixture",country:"EE",aliases:["Fixture display spelling"]},"display spelling"));
 assert.equal(normalizeBankName("Ålandsbanken"),"alandsbanken");
});
