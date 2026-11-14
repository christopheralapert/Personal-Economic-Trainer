"use client";

import {useState,type FormEvent} from "react";
import type {components} from "@contracts";
import {planDate} from "./plan-format";

type Preferences=components["schemas"]["CoachingPreferencesViewV1"];
export type CoachingFields=Required<Pick<Preferences,"coaching_enabled"|"bill_insights"|"headroom_insights"|"spending_insights"|"timezone"|"quiet_start"|"quiet_end">>;

export function CoachingPreferencesForm({preferences,locked,save,pause}:{preferences:Preferences;locked:boolean;save:(fields:CoachingFields)=>void;pause:(hours:24|null)=>void}) {
  const [fields,setFields]=useState<CoachingFields>(()=>({coaching_enabled:preferences.coaching_enabled,bill_insights:preferences.bill_insights,
    headroom_insights:preferences.headroom_insights,spending_insights:preferences.spending_insights,timezone:preferences.timezone??"Europe/Helsinki",
    quiet_start:preferences.quiet_start??null,quiet_end:preferences.quiet_end??null}));
  const [quiet,setQuiet]=useState(preferences.quiet_start!=null);
  const [error,setError]=useState("");
  const submit=(event:FormEvent)=>{
    event.preventDefault();setError("");
    const timezone=fields.timezone.trim();
    try {new Intl.DateTimeFormat("en-GB",{timeZone:timezone});} catch {setError("Choose an IANA time zone, for example Europe/Helsinki.");return;}
    if(quiet && (!fields.quiet_start || !fields.quiet_end || fields.quiet_start===fields.quiet_end)) {
      setError("Choose two different quiet-hour times, or turn quiet hours off.");return;
    }
    save({...fields,timezone,quiet_start:quiet ? fields.quiet_start : null,quiet_end:quiet ? fields.quiet_end : null});
  };
  const check=(name:"coaching_enabled"|"bill_insights"|"headroom_insights"|"spending_insights",label:string)=><label className="check-field"><input type="checkbox" checked={fields[name]} onChange={event=>setFields({...fields,[name]:event.target.checked})}/><span>{label}</span></label>;
  return <details className="panel review-panel coaching-section coaching-preferences" open={!preferences.coaching_enabled}>
    <summary><h2>Coaching preferences</h2><span>Manage coaching preferences</span></summary>
    <p className="field-hint">Choose which notices may be generated. Delivery is inside this app; device notifications are not available yet.</p>
    <form onSubmit={submit}><fieldset disabled={locked}>
      {check("coaching_enabled","Enable coaching notices")}
      <fieldset className="coaching-kinds"><legend>What would you like to review?</legend>
        {check("bill_insights","Upcoming bills")}{check("headroom_insights","Low headroom")}{check("spending_insights","Higher observed spending")}
      </fieldset>
      <label className="check-field"><input type="checkbox" checked={quiet} onChange={event=>setQuiet(event.target.checked)}/><span>Set quiet hours</span></label>
      {quiet && <div className="plan-fields"><label className="plan-field">Quiet hours start<input type="time" required value={fields.quiet_start??""} onChange={event=>setFields({...fields,quiet_start:event.target.value})}/></label>
        <label className="plan-field">Quiet hours end<input type="time" required value={fields.quiet_end??""} onChange={event=>setFields({...fields,quiet_end:event.target.value})}/></label></div>}
      <label className="plan-field">Time zone<input required maxLength={100} autoComplete="off" value={fields.timezone} onChange={event=>setFields({...fields,timezone:event.target.value})}/></label>
      <p className="field-hint">Quiet hours follow local clock time, including overnight windows. They keep your in-app history visible and are saved for future notification delivery.</p>
      {error && <p role="alert" className="error-notice">{error}</p>}
      <div className="plan-actions"><button className="primary-button" type="submit">Save preferences</button></div>
    </fieldset></form>
    <div className="coaching-pause"><p className="field-hint">{preferences.state.paused && preferences.paused_until ? `Generation is paused until ${planDate(preferences.paused_until)} (Helsinki).` : "No active pause was recorded when these preferences were loaded."}</p>
      <div className="plan-actions"><button type="button" className="secondary-button" disabled={locked||!preferences.coaching_enabled} onClick={()=>pause(24)}>Pause for 24 hours</button>
        <button type="button" className="text-button" disabled={locked||!preferences.state.paused} onClick={()=>pause(null)}>Resume coaching</button></div>
      <p className="field-hint">Pause and resume use your saved choices. Save any form changes first. Turning coaching off keeps your owned notice history.</p>
    </div>
  </details>;
}
