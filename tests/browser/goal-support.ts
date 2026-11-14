import type {Page} from "@playwright/test";
import type {components} from "../../packages/contracts/api";
import fixture from "../../fixtures/synthetic/goals-ui.v1.json";
import planning from "../../fixtures/synthetic/planning-ui.v1.json";

type Goal=components["schemas"]["GoalViewV1"];

export async function mockGoals(page:Page,options:{initial?:"empty"|"reserved";failOnce?:boolean;conflict?:boolean;unavailable?:boolean;second?:boolean}={}) {
  await page.clock.install({time:new Date(fixture.clock)});
  let authenticated=false,lost=false,collection=2;
  const goals:Goal[]=options.initial ? [structuredClone(fixture[options.initial]) as Goal] : [];
  if(options.second) goals.push({...structuredClone(fixture.empty) as Goal,id:"00000000-0000-0000-0000-000000000312",name:"Travel fund"});
  let assigned=options.initial==="reserved";
  const calls:{path:string;body:Record<string,unknown>}[]=[];
  const receipts=new Map<string,unknown>();
  const snapshot=(goal:Goal)=>{const result=structuredClone(goal);result.collection_version=collection;return result;};
  await page.route("**/api/v1/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/v1/","");
    const respond=(value:unknown,status=200)=>route.fulfill({status,json:value,headers:{"Cache-Control":"private, no-store"}});
    if(path==="auth/demo") {authenticated=true;return respond(planning.session);}
    if(!authenticated) return respond({error:{code:"UNAUTHENTICATED"}},401);
    if(path==="auth/session") return respond(planning.session);
    if(path==="auth/logout") {authenticated=false;return route.fulfill({status:204});}
    if(request.headers()["x-moneylens-session-id"]!==planning.session.session_id) throw new Error("Goal requests must bind the verified session.");
    if(request.method()==="GET") {
      if(options.unavailable && path==="goals") return respond({error:{code:"SERVICE_UNAVAILABLE",message:"Goal information is unavailable. Try again."}},503);
      if(path==="goals") {
        const filter=url.searchParams.get("state");
        const rows=goals.filter(goal=>filter ? goal.state===filter : goal.state!=="removed").map(snapshot);
        return respond({rows,next_cursor:null,collection_version:collection,data_version:1,plan_version:3,as_of:fixture.clock});
      }
      if(path==="plans/current") return respond(planning.states.reserved.plan);
      if(path===`plans/${planning.receipt.plan_id}/allocations`) return respond({rows:[planning.receipt],next_cursor:null,data_version:1,plan_version:3});
      const goal=goals.find(item=>path===`goals/${item.id}` || path===`goals/${item.id}/allocations`);
      if(goal) return path.endsWith("/allocations") ? respond({goal_id:goal.id,goal_version:goal.version,rows:assigned ? [planning.receipt] : [],next_cursor:null,collection_version:collection,data_version:1,plan_version:3,as_of:fixture.clock}) : respond(snapshot(goal));
      return respond({error:{code:"NOT_FOUND"}},404);
    }
    if(request.headers()["x-csrf-token"]!==planning.session.csrf_token) throw new Error("Goal writes must include CSRF.");
    const body=request.postDataJSON() as Record<string,unknown>;calls.push({path,body});
    if(receipts.has(String(body.key))) return respond(receipts.get(String(body.key)));
    if(options.conflict) return respond({error:{code:"GOAL_VERSION_CHANGED"}},409);
    let goal=goals.find(item=>path.startsWith(`goals/${item.id}/`));
    const action=path==="goals" ? "create" : path.endsWith("/link") ? "link_allocation" : path.endsWith("/unlink") ? "unlink_allocation" : path.split("/").at(-1)==="state" ? "set_state" : path.split("/").at(-1)!;
    if(path==="goals") {goal={...structuredClone(fixture.empty) as Goal,name:String(body.name),target_minor:Number(body.target_minor),deadline:String(body.deadline),priority:Number(body.priority)};goals.push(goal);}
    else if(goal) {
      goal.version++;
      if(action==="revise") Object.assign(goal,{name:body.name,target_minor:body.target_minor,deadline:body.deadline,priority:body.priority});
      if(action==="set_state") goal.state=body.state as Goal["state"];
      if(action==="remove") goal.state="removed";
      if(action==="link_allocation") {assigned=true;goal.progress=structuredClone(fixture.reserved.progress) as Goal["progress"];}
      if(action==="unlink_allocation") {assigned=false;goal.progress=structuredClone(fixture.empty.progress) as Goal["progress"];}
    }
    if(!goal) return respond({error:{code:"NOT_FOUND"}},404);
    collection++;
    const {as_of,collection_version,data_version,plan_version,progress,...metadata}=goal;
    const receipt={schema_version:"goal-command.v1",id:crypto.randomUUID(),action,goal:metadata,collection_version:collection,applied_at:fixture.clock,historical_command_snapshot:true,
      ...(action.includes("allocation") ? {allocation_id:planning.receipt.id,reservation_mutated:false,bank_transfer_executed:false} : {})};
    receipts.set(String(body.key),receipt);
    if(options.failOnce && !lost) {lost=true;return route.abort("failed");}
    return respond(receipt);
  });
  return {calls,goals};
}

export async function signInGoals(page:Page) {
  await page.goto("/goals");await page.getByRole("button",{name:"Continue as Aino"}).click();
  await page.getByRole("heading",{name:"Your savings goals",exact:true}).waitFor();
}
