"use client";
import {useState} from "react";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {useCopy,categoryLabel} from "@/i18n/context";
import {spendByCategory} from "@/engine";
import {createBasketPlan} from "@/lib/basket-plan";
import {goalAmountMinor,goalAmountInput} from "@/lib/savings-goal";
import {Button} from "./ui/button";
import {Input} from "./ui/input";
import {RadioGroup,RadioGroupItem} from "./ui/radio-group";
export function CategoryLimit(){const {data}=useMoneyData(),planning=usePlanning(),{t,savings}=useCopy(),groups=spendByCategory(planning.period,data).filter(group=>group.amount>0),[category,setCategory]=useState(planning.basketPlan?.category??groups[0]?.key??""),[limit,setLimit]=useState(planning.basketPlan ? goalAmountInput(planning.basketPlan.limitMinor) : ""),[saved,setSaved]=useState(false),minor=goalAmountMinor(limit);return <section className="space-y-3"><h3 className="font-semibold">{t("optionalCategoryLimit")}</h3><RadioGroup aria-label={t("category")} value={category} onValueChange={value=>{setCategory(value);setSaved(false);}} className="grid grid-cols-2">{groups.map(group=><label key={group.key} className="flex min-h-touch items-center gap-3"><RadioGroupItem value={group.key}/>{categoryLabel(group.key,t)}</label>)}</RadioGroup><label className="block space-y-2"><span>{t("categoryLimit")}</span><Input inputMode="decimal" value={limit} maxLength={12} onChange={event=>{setLimit(event.target.value);setSaved(false);}}/></label><Button disabled={minor===null || minor>100000000 || !groups.some(group=>group.key===category)} onClick={()=>{planning.saveBasketPlan(createBasketPlan(category,minor!,savings,planning.period,data));setSaved(true);}}>{t("savePlan")}</Button>{saved && <p role="status">{t("planSaved")}</p>}<p className="text-caption text-ink-2">{t("planNotMoved")}</p></section>;}
