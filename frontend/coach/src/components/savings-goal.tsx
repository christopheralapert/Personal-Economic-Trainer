"use client";
import {useEffect,useId,useRef,useState,type FormEvent} from "react";
import {useCopy} from "@/i18n/context";
import {money} from "@/lib/format";
import {goalAmountInput,goalAmountMinor,type SavingsGoal} from "@/lib/savings-goal";
import {StepperHeader} from "./gen/stepper-header";
import {Button} from "./ui/button";
import {Input} from "./ui/input";

export function SavingsGoalFlow({initial,onBack,onSave}:{initial:SavingsGoal|null;onBack:()=>void;onSave:(goal:SavingsGoal)=>void}) {
  const {t}=useCopy(),id=useId(),[step,setStep]=useState<1|2|3>(1);
  const [name,setName]=useState(initial?.name ?? ""),[amount,setAmount]=useState(initial ? goalAmountInput(initial.amountMinor) : ""),[error,setError]=useState(false);
  const input=useRef<HTMLInputElement>(null),review=useRef<HTMLHeadingElement>(null);
  const minor=goalAmountMinor(amount),validName=name.trim().length>0 && name.trim().length<=80;
  useEffect(()=>{(step===3 ? review.current : input.current)?.focus({preventScroll:true});},[step]);
  function back(){setError(false);if(step===1) onBack();else setStep((step-1) as 1|2);}
  function submit(event:FormEvent){
    event.preventDefault();
    if(step===1 && validName){setName(name.trim());setStep(2);setError(false);}
    else if(step===2 && validName && minor!==null){setStep(3);setError(false);}
    else if(step===3 && validName && minor!==null) onSave({name:name.trim(),amountMinor:minor});
    else setError(true);
  }
  return <form noValidate className="space-y-6" onSubmit={submit}>
    <StepperHeader step={step} onBack={back}/><p className="text-sm text-ink-2">{t("goalLocal")}</p>
    {step===1 ? <label className="block space-y-2" htmlFor={`${id}-name`}><span>{t("goalName")}</span><Input ref={input} id={`${id}-name`} value={name} maxLength={80} autoComplete="off" placeholder={t("goalPlaceholder")} aria-invalid={error} aria-describedby={error ? `${id}-error` : undefined} onChange={event=>{setName(event.target.value);setError(false);}}/></label>
      : step===2 ? <label className="block space-y-2" htmlFor={`${id}-amount`}><span>{t("goalAmount")}</span><Input ref={input} id={`${id}-amount`} inputMode="decimal" autoComplete="off" value={amount} maxLength={19} aria-invalid={error} aria-describedby={error ? `${id}-error` : undefined} onChange={event=>{setAmount(event.target.value);setError(false);}}/></label>
      : <div className="space-y-3 rounded-3xl bg-tile-saving p-4"><h3 ref={review} tabIndex={-1} className="font-semibold">{t("goalReview")}</h3><p className="wrap-anywhere text-xl font-bold">{name}</p><p className="wrap-anywhere text-balance font-bold">{money(minor!)}</p></div>}
    {error && <p id={`${id}-error`} role="alert" className="text-sm text-neg">{t(step===1 ? "goalNameError" : "goalAmountError")}</p>}
    <Button type="submit" className="w-full">{t(step===3 ? "saveGoal" : "next")}</Button>
  </form>;
}
