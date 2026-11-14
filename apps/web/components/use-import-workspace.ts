"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import type {components} from "@contracts";
import {aborted,PrivateApiError,type PrivateRequest,type PrivateTransfer} from "./private-session";
import {readManifest,type FileRole,type SelectedFiles} from "./import-files";

type Schema=components["schemas"];
export type ImportDetail={id:string;intake:Schema["ImportViewV1"]|null;validation:Schema["ImportValidationViewV1"]|null;publication:Schema["ImportPublicationViewV1"]|null};
type Command={path:string;body:object;kind:"create"|"action"};
const missing=(reason:unknown)=>reason instanceof PrivateApiError && reason.code==="NOT_FOUND";
const moved=(reason:unknown)=>reason instanceof PrivateApiError && reason.code==="IMPORT_INTAKE_MOVED";
const definite=new Set(["INVALID_REQUEST","INVALID_IMPORT_COMMAND","IDEMPOTENCY_CONFLICT","IMPORT_TOO_LARGE","IMPORT_INTAKE_THROTTLED",
  "IMPORT_COMMAND_THROTTLED","IMPORT_UNAVAILABLE","IMPORT_SYNTHETIC_REQUIRED","IMPORT_UPLOAD_CLOSED","IMPORT_ALREADY_VERIFIED",
  "IMPORT_VALIDATION_CLOSED","IMPORT_SOURCE_NOT_VERIFIED","IMPORT_VALIDATION_REQUIRED","IMPORT_PUBLICATION_CLOSED","IMPORT_INTAKE_MOVED","NOT_FOUND"]);
const message=(reason:unknown)=>reason instanceof PrivateApiError ? reason.message : "The response could not be confirmed. Retry the same request before making another change.";

export function useImportWorkspace(request:PrivateRequest,transfer:PrivateTransfer,changed:()=>void) {
  const [capabilities,setCapabilities]=useState<Schema["ImportCapabilitiesV1"]|null>(null);
  const [history,setHistory]=useState<Schema["ImportListV1"]|null>(null);
  const [detail,setDetail]=useState<ImportDetail|null>(null);
  const [manifest,setManifest]=useState<Schema["ImportManifestV1"]|null>(null);
  const [selected,setSelected]=useState<SelectedFiles>({});
  const [manifestName,setManifestName]=useState("");
  const [selectionVersion,setSelectionVersion]=useState(0);
  const [pending,setPending]=useState<Command|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [reading,setReading]=useState(false);
  const [parsing,setParsing]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [sending,setSending]=useState<FileRole|null>(null);
  const [polling,setPolling]=useState(false);
  const mounted=useRef(true),locked=useRef(false),current=useRef<string|null>(null);
  const catalogueEpoch=useRef(0),detailEpoch=useRef(0),draftEpoch=useRef(0),pollBudget=useRef(0);
  const published=useRef<string|undefined>(undefined);
  const transferScope=useRef<AbortController|null>(null);

  const loadHistory=useCallback(async (before?:string)=>{
    const epoch=++catalogueEpoch.current;
    setLoading(true);
    try {
      const [caps,list]=await Promise.allSettled([request<Schema["ImportCapabilitiesV1"]>("imports/capabilities"),
        request<Schema["ImportListV1"]>(`imports${before ? `?before_id=${encodeURIComponent(before)}` : ""}`)]);
      if (!mounted.current || epoch!==catalogueEpoch.current) return;
      setCapabilities(caps.status==="fulfilled" ? caps.value : null);
      setHistory(list.status==="fulfilled" ? list.value : null);
      if (caps.status==="rejected" || list.status==="rejected") {
        const reason=caps.status==="rejected" ? caps.reason : list.status==="rejected" ? list.reason : null;
        if (!aborted(reason)) setError(message(reason));
      }
    } finally {if (mounted.current && epoch===catalogueEpoch.current) setLoading(false);}
  },[request]);

  const loadDetail=useCallback(async (identifier:string)=>{
    const epoch=++detailEpoch.current;
    setReading(true);setDetail(null);setPolling(false);
    try {
      const [source,validation,publication]=await Promise.allSettled([
        request<Schema["ImportViewV1"]>(`imports/${identifier}`),
        request<Schema["ImportValidationViewV1"]>(`imports/${identifier}/validation`),
        request<Schema["ImportPublicationViewV1"]>(`imports/${identifier}/publication`),
      ]);
      if (!mounted.current || epoch!==detailEpoch.current || current.current!==identifier) return;
      if (source.status==="rejected" && !moved(source.reason)) throw source.reason;
      if (validation.status==="rejected" && !missing(validation.reason)) throw validation.reason;
      if (publication.status==="rejected" && !missing(publication.reason)) throw publication.reason;
      if (source.status==="rejected" && publication.status!=="fulfilled") throw new Error("Source changed while loading");
      const next={id:identifier,intake:source.status==="fulfilled" ? source.value : null,
        validation:validation.status==="fulfilled" ? validation.value : null,publication:publication.status==="fulfilled" ? publication.value : null};
      setDetail(next);setManifest(next.publication?.manifest ?? next.intake!.manifest);
      if (next.intake?.source_integrity_verified || next.publication) setSelected({});
      const signature=next.publication?.active ? `${next.publication.id}:${next.publication.published_data_version}` : "";
      if (published.current!==undefined && published.current!==signature) changed();
      published.current=signature;
      const job=next.publication?.job ?? next.validation?.job ?? next.intake?.job;
      setPolling(!!job && ["queued","running"].includes(job.state));
    } catch (reason) {
      if (mounted.current && epoch===detailEpoch.current && !aborted(reason)) {
        setDetail(null);setPolling(false);setError(message(reason));
      }
    } finally {if (mounted.current && epoch===detailEpoch.current) setReading(false);}
  },[request,changed]);

  useEffect(()=>{mounted.current=true;void loadHistory();return()=>{
    mounted.current=false;catalogueEpoch.current++;detailEpoch.current++;draftEpoch.current++;transferScope.current?.abort();
  };},[loadHistory]);

  useEffect(()=>{
    if (!polling || !detail) return;
    if (pollBudget.current<=0) {setPolling(false);setNotice("The background work is still pending. You can return later or check status again.");return;}
    const timer=window.setTimeout(()=>{pollBudget.current--;if (current.current) void loadDetail(current.current);},5000);
    return()=>window.clearTimeout(timer);
  },[polling,detail,loadDetail]);

  const execute=async (command:Command)=>{
    if (locked.current || (pending && command!==pending)) return;
    locked.current=true;setBusy(true);setPending(command);setError("");setNotice("");
    try {
      const receipt=await request<Schema["ImportReceiptV1"]|Schema["ImportValidationReceiptV1"]|Schema["ImportPublicationReceiptV1"]>(command.path,command.body);
      if (!mounted.current) return;
      setPending(null);current.current=receipt.import_id;
      if (command.kind==="create") setNotice("Private upload prepared. Choose Upload and check files to send your selected files.");
      else setNotice("Request recorded. The current status below shows whether background work has finished.");
      pollBudget.current=12;
      await Promise.all([loadDetail(receipt.import_id),loadHistory()]);
    } catch (reason) {
      if (!mounted.current || aborted(reason)) return;
      setError(message(reason));
      if (reason instanceof PrivateApiError && definite.has(reason.code)) setPending(null);
    } finally {locked.current=false;if (mounted.current) setBusy(false);}
  };

  const chooseManifest=async (file:File|undefined)=>{
    if (locked.current || pending) return;
    const epoch=++draftEpoch.current;
    setManifest(null);setSelected({});setSelectionVersion(value=>value+1);setManifestName("");setError("");setNotice("");setParsing(true);
    try {
      if (!file) return;
      if (file.size>8192) throw new Error("The manifest is larger than 8 KiB. Choose the small JSON manifest, not a transaction file.");
      const parsed=readManifest(await file.text());
      if (!mounted.current || epoch!==draftEpoch.current) return;
      const total=parsed.files.reduce((sum,item)=>sum+item.size_bytes,0);
      if (capabilities && total>capabilities.maximum_source_bytes) throw new Error("This source is larger than this demo's import limit. Use a smaller complete export.");
      setManifest(parsed);setManifestName(file.name);
    } catch (reason) {if (mounted.current && epoch===draftEpoch.current) setError(reason instanceof Error ? reason.message : "Choose a compatible source manifest.");}
    finally {if (mounted.current && epoch===draftEpoch.current) setParsing(false);}
  };

  const open=async (identifier:string)=>{
    if (locked.current || pending) return;
    draftEpoch.current++;setParsing(false);setSelected({});setSelectionVersion(value=>value+1);setManifest(null);setManifestName("");setError("");setNotice("");
    current.current=identifier;published.current=undefined;pollBudget.current=12;
    await loadDetail(identifier);
  };

  const reset=()=>{
    if (locked.current || pending) return;
    detailEpoch.current++;draftEpoch.current++;current.current=null;published.current=undefined;
    setDetail(null);setManifest(null);setManifestName("");setSelected({});setSelectionVersion(value=>value+1);setPolling(false);setReading(false);setParsing(false);setError("");setNotice("");
  };

  const upload=async ()=>{
    const identifier=current.current;
    if (locked.current || pending || !identifier || !manifest || !capabilities?.enabled) return;
    if (manifest.files.some(item=>selected[item.role]?.size!==item.size_bytes)) {setError("Choose every original source file with the declared size before uploading.");return;}
    locked.current=true;setBusy(true);setError("");setNotice("");
    const controller=new AbortController();transferScope.current=controller;
    let sent=false;
    try {
      const links=await request<Schema["ImportUploadLinksV1"]>(`imports/${identifier}/upload-links`,{});
      if (!mounted.current || current.current!==identifier) return;
      if (links.import_id!==identifier || links.files.length!==manifest.files.length || new Set(links.files.map(link=>link.role)).size!==links.files.length ||
          links.files.some(link=>!manifest.files.some(file=>file.role===link.role && file.size_bytes===link.size_bytes))) throw new Error("Invalid upload response");
      for (const link of links.files) {
        if (!mounted.current || current.current!==identifier) return;
        setSending(link.role);await transfer(link,selected[link.role]!,controller.signal);
      }
      sent=true;
    } catch (reason) {if (mounted.current && !aborted(reason)) setError(message(reason));}
    finally {locked.current=false;if (transferScope.current===controller) transferScope.current=null;if (mounted.current) {setBusy(false);setSending(null);}}
    if (sent && mounted.current && current.current===identifier) await execute({kind:"action",path:`imports/${identifier}/submit`,body:{key:crypto.randomUUID()}});
  };

  const action=(path:string)=>{
    if (current.current) void execute({kind:"action",path:`imports/${current.current}/${path}`,body:{key:crypto.randomUUID()}});
  };
  return {capabilities,history,detail,manifest,manifestName,selectionVersion,selected,pending,busy,loading,reading,parsing,error,notice,sending,polling,
    locked:busy || !!pending || reading || parsing,identifier:current.current,
    chooseManifest,chooseFile:(role:FileRole,file:File|undefined)=>setSelected(value=>({...value,[role]:file})),
    prepare:()=>manifest && void execute({kind:"create",path:"imports",body:{key:crypto.randomUUID(),manifest:structuredClone(manifest)}}),
    retry:()=>pending && void execute(pending),upload,action,open,reset,
    reload:()=>{setError("");pollBudget.current=12;void loadHistory();if (current.current) void loadDetail(current.current);},
    more:()=>history?.next_before_id && void loadHistory(history.next_before_id)};
}
