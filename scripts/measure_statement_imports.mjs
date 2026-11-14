/** Synthetic-only browser timing against an already running isolated test-issuer preview. */
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {performance} from "node:perf_hooks";
import {chromium,expect} from "@playwright/test";

export function syntheticCsv(count=700){
  assert(Number.isInteger(count)&&count>=1&&count<=1000,"Use 1–1000 synthetic rows");
  return "TransferWise ID,Date,Amount,Currency,Description\n"+
    Array.from({length:count},(_,index)=>`r${index},03-10-2026,-5.00,EUR,Synthetic shop\n`).join("");
}

async function signIn(page,origin,subject){
  await page.goto(origin+"/banks");
  await page.getByRole("link",{name:"Sign in with your identity provider",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Isolated synthetic identity",exact:true})).toBeVisible();
  await page.getByRole("link",{name:subject,exact:true}).click();
  return page.goto(origin+"/banks");
}

export async function measure(origin){
  assert(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin),"Use an explicit loopback test origin");
  assert.equal(process.env.MONEYLENS_PERFORMANCE_REHEARSAL,"true","Explicit synthetic rehearsal opt-in required");
  const browser=await chromium.launch({channel:"chrome"});
  const csv=syntheticCsv(),results=[],accounts=[];
  try{
    for(const temperature of ["cold","warm"]){
      const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:"block"});
      try{
        const page=await context.newPage(),subject="large-"+temperature;
        const navigation=await signIn(page,origin,subject),build=navigation.headers()["x-moneylens-build"];
        const name="synthetic-large.csv",item=page.locator(`[data-statement-file="${name}"]`);
        await page.getByLabel("Choose statements",{exact:true}).setInputFiles({name,mimeType:"text/csv",buffer:Buffer.from(csv)});
        const pending=page.waitForResponse(response=>response.url().endsWith("/statements/wise/preview"));
        let tick=performance.now();await page.getByRole("button",{name:"Preview statements",exact:true}).click();
        const preview=await pending;assert.equal(preview.status(),200);
        const staged=await preview.json();assert.equal(staged.state,"preview");assert.equal(staged.count,700);
        await expect(item.getByText(/Statement period:/)).toBeVisible();
        await expect(page.getByRole("button",{name:"Confirm imports",exact:true})).toBeVisible();
        const previewMs=Math.round(performance.now()-tick);
        // Required account choice is outside the preview and confirmation timers.
        await item.getByLabel("Account",{exact:true}).selectOption("new");
        await item.getByLabel("New account name",{exact:true}).fill("Synthetic 700 "+temperature);
        const confirming=page.waitForResponse(response=>response.url().endsWith("/statements/wise/confirm"));
        tick=performance.now();await page.getByRole("button",{name:"Confirm imports",exact:true}).click();
        const confirmation=await confirming;assert.equal(confirmation.status(),200);
        const saved=await confirmation.json();assert.equal(saved.added_count,700);assert.equal(saved.files[0].count,700);
        const account=saved.files[0].account_id;
        await expect(item.getByRole("link",{name:"View transactions",exact:true})).toBeVisible();
        const confirmedMs=Math.round(performance.now()-tick);
        await item.getByRole("link",{name:"View transactions",exact:true}).click();
        await expect(page.locator("[data-ledger-row]").first()).toBeVisible();
        const confirmationToVisibleRowsMs=Math.round(performance.now()-tick);
        await page.goto(origin+"/coach");
        await expect(page.getByRole("checkbox",{name:"Privacy mode",exact:true})).toBeChecked();
        await page.locator("#coach-question").fill("Show transactions from 2026-10-01 until 2026-11-01");
        const answer=page.waitForResponse(response=>response.url().endsWith("/coach/query"));
        tick=performance.now();await page.getByRole("button",{name:"Read my records",exact:true}).click();
        const response=await answer;assert.equal(response.status(),200);
        const body=await response.json();assert.equal(body.source,"rule");assert.equal(body.provider,null);
        await expect(page.locator("[data-coach-ledger-row]").first()).toBeVisible();
        const localQuestionToVisibleRowsMs=Math.round(performance.now()-tick);
        const result={build,rows:700,bytes:Buffer.byteLength(csv),temperature,firstJourneyInProcess:temperature==="cold",
          previewMs,confirmedMs,confirmationToVisibleRowsMs,localQuestionToVisibleRowsMs,
          serverTiming:response.headers()["server-timing"]??null,modelRequests:0};
        results.push(result);accounts.push({subject,account});console.log(JSON.stringify(result));
      }finally{await context.close();}
    }
    // Verify every saved row only after both timed journeys; do not warm the next measurement.
    for(const [index,{subject,account}] of accounts.entries()){
      const context=await browser.newContext({serviceWorkers:"block"});
      try{
        const page=await context.newPage();await signIn(page,origin,subject);
        const totals=await page.evaluate(async account=>{
          let cursor=null,count=0,sum=0;const ids=new Set();
          do{
            const query=new URLSearchParams({start:"2026-10-01",end_exclusive:"2026-11-01",account_id:account,limit:"200"});
            if(cursor)query.set("cursor",cursor);
            const response=await fetch("/api/v1/ledger/transactions?"+query);if(!response.ok)throw Error("Ledger verification failed");
            const data=await response.json();for(const row of data.rows){count++;sum+=row.amount_minor;ids.add(row.id);}
            cursor=data.next_cursor;if(count>700)throw Error("Unexpected duplicate rows");
          }while(cursor);
          return {count,sum,distinct:ids.size};
        },account);
        assert.deepEqual(totals,{count:700,sum:-350000,distinct:700});results[index].savedRowsVerified=totals.count;
      }finally{await context.close();}
    }
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
    const directory=path.join(root,"test-results/statement-performance");await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,"last-run.json"),JSON.stringify({
      protocol:"Fresh API/web/database before run; cold first import, warm fresh owner/context in same process. Operator must ensure cold condition.",
      viewport:{width:390,height:844},serviceWorkers:"block",results},null,2)+"\n");
    return results;
  }finally{await browser.close();}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  measure(process.argv[2]??"http://127.0.0.1:33120").catch(error=>{console.error(error.message);process.exitCode=1;});
}
