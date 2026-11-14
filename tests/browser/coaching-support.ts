import type {Page} from "@playwright/test";
import type {components} from "../../packages/contracts/api";
import fixture from "../../fixtures/synthetic/coaching-ui.v1.json";
import planning from "../../fixtures/synthetic/planning-ui.v1.json";

type Preferences=components["schemas"]["CoachingPreferencesViewV1"];
type Insight=components["schemas"]["InsightViewV1"];
type Job=components["schemas"]["JobStatusView"];
type Options={enabled?:boolean;notices?:boolean;stale?:boolean;failOnce?:"preferences"|"dismiss"|"refresh";conflict?:boolean;unavailable?:boolean;pagination?:boolean;jobFails?:boolean};

/** Mock transport around generated domain facts, never a model or bank call. */
export async function mockCoaching(page:Page,options:Options={}) {
  await page.clock.install({time:new Date(fixture.clock)});
  let authenticated=false,lost=false,collection=2,jobReads=0;
  let preferences=structuredClone(options.enabled ? fixture.preferences.enabled : fixture.preferences.default) as Preferences;
  const records:Insight[]=options.notices ? structuredClone(fixture.records) as Insight[] : [];
  if(options.stale) for(const record of records) {record.current=false;record.current_blockers=["INSIGHT_EVIDENCE_EXPIRED"];}
  const calls:{path:string;body:Record<string,unknown>}[]=[],reads:string[]=[];
  const receipts=new Map<string,unknown>();let job:Job|null=null;
  const state=()=>{
    const paused=preferences.paused_until!==null && Date.parse(preferences.paused_until)>Date.parse(fixture.clock);
    const wall=new Intl.DateTimeFormat("en-GB",{timeZone:preferences.timezone,hourCycle:"h23",hour:"2-digit",minute:"2-digit"}).format(new Date(fixture.clock));
    const start=preferences.quiet_start,end=preferences.quiet_end;
    const quiet_now=!!(start && end && (start<end ? start<=wall && wall<end : wall>=start || wall<end));
    return {...structuredClone(preferences),as_of:fixture.clock,state:{...preferences.state,paused,quiet_now,generation_active:preferences.coaching_enabled&&!paused}};
  };
  const present=(record:Insight)=>{
    const view=structuredClone(record);
    if(record.preferences_version!==preferences.version || !preferences.coaching_enabled || state().state.paused) {
      view.current=false;view.current_blockers=["INSIGHT_CONTEXT_CHANGED"];
    }
    return view;
  };
  await page.route("**/api/v1/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/v1/","");
    const respond=(value:unknown,status=200)=>route.fulfill({status,json:value,headers:{"Cache-Control":"private, no-store"}});
    if(path==="auth/demo") {authenticated=true;return respond(planning.session);}
    if(!authenticated) return respond({error:{code:"UNAUTHENTICATED"}},401);
    if(path==="auth/session") return respond(planning.session);
    if(path==="auth/logout") {authenticated=false;return route.fulfill({status:204});}
    if(request.headers()["x-moneylens-session-id"]!==planning.session.session_id) throw new Error("Coaching reads and commands must bind the verified session.");
    if(request.method()==="GET") {
      reads.push(path+url.search);
      if(path==="coaching/preferences") return respond(state());
      if(path==="accounts") return respond(fixture.accounts);
      if(path==="insights") {
        if(options.unavailable) return respond({error:{code:"SERVICE_UNAVAILABLE",message:"Coaching history is unavailable. Try again."}},503);
        const status=url.searchParams.get("status")??"active";
        const filtered=records.filter(record=>record.status===status).map(record=>{
          const {evidence,...summary}=present(record);return {...summary,evidence_kind:evidence.kind};
        });
        const cursor=url.searchParams.get("cursor");
        return respond({rows:options.pagination ? filtered.slice(cursor?2:0,cursor?undefined:2) : filtered,
          next_cursor:options.pagination&&!cursor&&filtered.length>2?"ui-only-page-2":null,
          collection_version:collection,data_version:1,plan_version:1,preferences_version:preferences.version,as_of:fixture.clock});
      }
      const record=records.find(item=>path===`insights/${item.id}`);
      if(record) return respond(present(record));
      if(job && path===`jobs/${job.id}`) {
        jobReads++;
        if(jobReads>=2) {
          job={...job,state:options.jobFails?"failed":"completed",attempts:1,finished_at:fixture.clock,last_error_code:options.jobFails?"coaching_refresh_failed":null};
          if(!options.jobFails && preferences.coaching_enabled && !state().state.paused) {
            if(!records.length) records.push(...structuredClone(fixture.records) as Insight[]);
            for(const item of records) {item.preferences_version=preferences.version;item.current=item.status==="active";item.current_blockers=[];}
          }
        } else job={...job,state:"running",attempts:1};
        return respond(job);
      }
      return respond({error:{code:"NOT_FOUND"}},404);
    }
    if(request.headers()["x-csrf-token"]!==planning.session.csrf_token) throw new Error("Coaching writes must include CSRF.");
    const body=request.postDataJSON() as Record<string,unknown>;calls.push({path,body});
    const receiptKey=`${path}:${String(body.key)}`;
    if(receipts.has(receiptKey)) return respond(receipts.get(receiptKey));
    if(options.conflict) return respond({error:{code:path==="coaching/preferences"?"COACHING_VERSION_CHANGED":"INSIGHT_VERSION_CHANGED"}},409);
    let result:unknown,kind:Options["failOnce"];
    if(path==="coaching/preferences") {
      if(body.expected_preferences_version!==preferences.version) return respond({error:{code:"COACHING_VERSION_CHANGED"}},409);
      const {key,expected_preferences_version,...fields}=body;
      preferences={...preferences,...fields,version:preferences.version+1,created_at:preferences.created_at??fixture.clock,updated_at:fixture.clock} as Preferences;
      const {as_of,state:dynamic,...snapshot}=preferences;
      result={schema_version:"coaching-command.v1",id:crypto.randomUUID(),action:"set_preferences",preferences:snapshot,
        applied_at:fixture.clock,historical_command_snapshot:true};kind="preferences";
    } else if(path==="insights/refresh") {
      if(!preferences.coaching_enabled) return respond({error:{code:"COACHING_OPT_IN_REQUIRED"}},409);
      job=structuredClone(fixture.job) as Job;jobReads=0;result=job;kind="refresh";
    } else {
      const record=records.find(item=>path===`insights/${item.id}/dismiss`);
      if(!record) return respond({error:{code:"NOT_FOUND"}},404);
      if(body.expected_insight_version!==record.version) return respond({error:{code:"INSIGHT_VERSION_CHANGED"}},409);
      record.version++;record.status="dismissed";record.current=false;record.current_blockers=["INSIGHT_DISMISSED"];record.dismissed_at=fixture.clock;collection++;
      result={schema_version:"insight-command.v1",id:crypto.randomUUID(),action:"dismiss",insight_id:record.id,insight_version:record.version,
        collection_version:collection,status:"dismissed",applied_at:fixture.clock,historical_command_snapshot:true};kind="dismiss";
    }
    receipts.set(receiptKey,result);
    if(options.failOnce===kind && !lost) {lost=true;return route.abort("failed");}
    return respond(result);
  });
  return {calls,reads,records,get preferences(){return state();},get jobReads(){return jobReads;}};
}

export async function signInCoaching(page:Page) {
  await page.goto("/insights");await page.getByRole("button",{name:"Continue as Aino"}).click();
  await page.getByRole("heading",{name:"Your coaching notices",exact:true}).waitFor();
}

export async function showCoachingPreferences(page:Page) {
  const summary=page.getByText("Manage coaching preferences",{exact:true});
  if(!(await page.getByRole("checkbox",{name:"Enable coaching notices",exact:true}).isVisible())) await summary.click();
}
